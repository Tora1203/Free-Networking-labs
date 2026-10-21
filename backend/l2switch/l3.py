"""L3スイッチの機能（swcliのプラグイン、2026-10-21〜。設計：docs/l3-switch-design.md）

fnl/l3switch のイメージにだけ入れる。swcliは起動時に `import l3` し、無ければL2スイッチのまま動く。

段階1（このファイル）：
  ・ip routing / no ip routing（既定は no ip routing。実機のCatalystも ip routing を入れるまでL3スイッチとして動かない）
  ・SVI（interface vlan N）の間のルーティング、静的経路（ip route）、show ip route
  ・ルーテッドポート（no switchport ＋ ip address）

方針：入力の窓口は swcli、経路の計算役は同じコンテナのFRR（zebra・staticd）。静的経路は設定（running-config）に持ち、
エージェントがFRRに入れる（FRRの設定ファイルは起動のたびに作り直すだけで、保存先は startup.json の1か所のまま）。

段階2（OSPF。BGP・RIPも同じ仕組み）：
  ・router ospf / router bgp N / router rip のモードに入り、中のコマンドをFRRのvtyshに渡す（Cisco風の書き方は翻訳する）
  ・interface vlan N / ルーテッドポートの ip ospf … もFRRに渡す
  ・FRRの設定（router … と interface … の塊）は設定の frr キーに行のリストで持ち、FRRの起動のたびに frr.conf に書き戻す
  ・show ip ospf … / show ip bgp … / show ip protocols はvtyshの出力のまま

設定のキー（cfg）：
  ip_routing : true の時だけ経路制御を動かす
  frr        : FRRの設定の行（'router ospf'、' network 10.0.0.0/24 area 0'、'!' …）。FRRの show running-config から写す
  routes     : [{"net": "10.1.0.0/24", "nh": "10.0.0.2"}, …]
  interfaces[<ethN>]: {"routed": true, "address": "10.0.0.1/30"}   （ルーテッドポート）
"""
import ipaddress
import os
import re
import subprocess
import time

import acl

FRR_DAEMONS = '/etc/frr/daemons'
FRR_CONF = '/etc/frr/frr.conf'
FRR_VTYSH_CONF = '/etc/frr/vtysh.conf'
FRR_INIT = '/usr/lib/frr/frrinit.sh'
NFT_TABLE = 'fnl_l3'
ROUTE_CHECK_SEC = 5
FRR_RETRY_SEC = 15
FRR_WAIT_SEC = 10
FRR_LOG = '/run/fnl-switch/frr-init.log'

NOT_ENABLED = 'Default gateway is not set'


def parse_net(ip, mask, mask_to_prefix, is_ipv4):
    """`ip route` の宛先とマスクを 'a.b.c.d/p' にする。ホスト部が立っていたらエラー文を返す"""
    prefix = mask_to_prefix(mask)
    if not is_ipv4(ip) or prefix is None:
        return None, '% Invalid input detected at \'^\' marker.'
    net = ipaddress.ip_network(f'{ip}/{prefix}', strict=False)
    if str(net.network_address) != ip:
        return None, '% Inconsistent address and mask'
    return str(net), None


# ---- Cisco風の書き方 ⇄ FRRの書き方（コンテナの外でもテストできる純粋な関数） ----

KEEP_PREFIXES = ('router ', 'interface ', 'route-map ', 'ip prefix-list ', 'ipv6 prefix-list ', 'ip as-path ', 'ip community-list ', 'bfd')  # access-list はACL（acl.py）の写しなので除く
ROUTER_PROTOCOLS = ('ospf', 'bgp', 'rip')
SINGLE_LINE_PREFIXES = ('ip prefix-list ', 'ip as-path ', 'ip community-list ')


def wildcard_to_prefix(wildcard, is_ipv4, mask_to_prefix):
    """0.0.0.255 → 24（ワイルドカードマスク）。連続していなければ None"""
    if not is_ipv4(wildcard):
        return None
    inverse = '.'.join(str(255 - int(x)) for x in wildcard.split('.'))
    return mask_to_prefix(inverse)


def classful_prefix(ip):
    first = int(ip.split('.')[0])
    return 8 if first < 128 else 16 if first < 192 else 24


def prefix_to_mask(prefix):
    mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF if prefix else 0
    return '.'.join(str((mask >> shift) & 255) for shift in (24, 16, 8, 0))


def prefix_to_wildcard(prefix):
    mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF if prefix else 0
    inv = mask ^ 0xFFFFFFFF
    return '.'.join(str((inv >> shift) & 255) for shift in (24, 16, 8, 0))


def join_vlan_names(tokens):
    """['passive-interface', 'vlan', '10'] → [..., 'vlan10']（カーネルのデバイス名。swcliは 'vlan 10' と分けて渡す）"""
    out = []
    i = 0
    while i < len(tokens):
        if tokens[i].lower() == 'vlan' and i + 1 < len(tokens) and tokens[i + 1].isdigit():
            out.append(f'vlan{tokens[i + 1]}')
            i += 2
        else:
            out.append(tokens[i].lower() if re.fullmatch(r'(?i)vlan\d+', tokens[i]) else tokens[i])
            i += 1
    return out


def translate_router_command(proto, tokens, is_ipv4, mask_to_prefix):
    """router ospf/bgp/rip の中のコマンドを、FRRのコマンドにする。(コマンド, エラー文)"""
    negate = bool(tokens) and tokens[0].lower() == 'no'
    body = join_vlan_names(tokens[1:] if negate else tokens)
    if not body:
        return None, '% Incomplete command.'
    head = body[0].lower()
    if proto == 'ospf':
        if head == 'network' and len(body) >= 5 and body[3].lower() == 'area':
            if '/' in body[1]:
                pass  # FRRの書き方のまま
            else:
                prefix = wildcard_to_prefix(body[2], is_ipv4, mask_to_prefix)
                if not is_ipv4(body[1]) or prefix is None:
                    return None, "% Invalid input detected at '^' marker."
                body = ['network', f'{body[1]}/{prefix}', 'area', body[4]]
        elif head == 'router-id':
            body = ['ospf', 'router-id'] + body[1:]
        elif head == 'redistribute':
            body = [t for t in body if t.lower() != 'subnets']
    elif proto == 'bgp':
        if head == 'network' and len(body) >= 2 and '/' not in body[1]:
            # network 10.10.1.0 mask 255.255.255.0 → network 10.10.1.0/24（maskを省くとクラスフルだが、FRRにはその形が無いので断る）
            if len(body) < 4 or body[2].lower() != 'mask':
                return None, '% Incomplete command. Use "network A.B.C.D mask M.M.M.M".'
            prefix = mask_to_prefix(body[3])
            if not is_ipv4(body[1]) or prefix is None:
                return None, "% Invalid input detected at '^' marker."
            body = ['network', f'{body[1]}/{prefix}'] + body[4:]
        elif head == 'aggregate-address' and len(body) >= 3 and '/' not in body[1]:
            prefix = mask_to_prefix(body[2])
            if not is_ipv4(body[1]) or prefix is None:
                return None, "% Invalid input detected at '^' marker."
            body = ['aggregate-address', f'{body[1]}/{prefix}'] + body[3:]
        elif head == 'address-family' and len(body) == 2:
            body = body + ['unicast']  # Ciscoの address-family ipv4 は、FRRでは ipv4 unicast
    elif proto == 'rip':
        if head in ('auto-summary',):
            return '', None  # FRRのRIPには無い（常にクラスレス）。Ciscoの no auto-summary は何もしない
        if head == 'network' and len(body) == 2 and '/' not in body[1] and is_ipv4(body[1]):
            body = ['network', f'{body[1]}/{classful_prefix(body[1])}']  # クラスフルの network
    return ('no ' if negate else '') + ' '.join(body), None


def translate_interface_command(tokens):
    """interface の中の ip ospf … をFRRのコマンドにする（ip ospf 1 area 0 → ip ospf area 0）"""
    body = list(tokens)
    if len(body) >= 5 and body[0:2] == ['ip', 'ospf'] and body[2].isdigit() and body[3].lower() == 'area':
        body = ['ip', 'ospf', 'area', body[4]]
    return ' '.join(body)


def translate_vrrp_command(tokens):
    """interface の中の vrrp … をFRRのコマンドにする（Cisco：timers advertise 秒 → FRR：advertisement-interval ミリ秒）"""
    body = list(tokens)
    if len(body) >= 4 and body[1:3] == ['timers', 'advertise'] and body[3].isdigit():
        body = [body[0], 'advertisement-interval', str(int(body[3]) * 1000)] + body[4:]
    return ' '.join(['vrrp'] + body)


def parse_frr_config(text):
    """vtyshの show running-config から、保存する塊（router … / interface … 等）の行を取り出す。
    ヘッダー・ip route（swcliの設定が持つ）・end・exit は含めない"""
    out = []
    keep = False
    for raw in text.splitlines():
        if not raw.strip() or raw.startswith('!'):
            continue
        if raw[0] not in ' \t':
            keep = raw.startswith(KEEP_PREFIXES)
            if keep:
                if out:
                    out.append('!')
                out.append(raw)
        elif keep:
            out.append(raw)
    return out


def split_stanzas(lines):
    stanzas, cur = [], []
    for line in lines:
        if line == '!':
            if cur:
                stanzas.append(cur)
            cur = []
        else:
            cur.append(line)
    if cur:
        stanzas.append(cur)
    return stanzas


def display_line(line, proto=None):
    """FRRの行をCiscoの書き方にして見せる（running-config用）。proto：router の種類（ospf/bgp/rip）"""
    if proto in ('bgp', 'rip'):
        m = re.fullmatch(r'(\s*)network (\d+\.\d+\.\d+\.\d+)/(\d+)', line)
        if m and proto == 'bgp':
            return f'{m.group(1)}network {m.group(2)} mask {prefix_to_mask(int(m.group(3)))}'
        if m and proto == 'rip' and int(m.group(3)) == classful_prefix(m.group(2)):
            return f'{m.group(1)}network {m.group(2)}'  # クラスフルの network（入れ直すと同じ長さに戻る形だけ）
        m = re.fullmatch(r'(\s*)aggregate-address (\d+\.\d+\.\d+\.\d+)/(\d+)(.*)', line)
        if m and proto == 'bgp':
            return f'{m.group(1)}aggregate-address {m.group(2)} {prefix_to_mask(int(m.group(3)))}{m.group(4)}'
    m = re.fullmatch(r'(\s*)network (\d+\.\d+\.\d+\.\d+)/(\d+) area (\S+)', line)
    if m:
        return f'{m.group(1)}network {m.group(2)} {prefix_to_wildcard(int(m.group(3)))} area {m.group(4)}'
    m = re.fullmatch(r'(\s*)ospf router-id (\S+)', line)
    if m:
        return f'{m.group(1)}router-id {m.group(2)}'
    m = re.fullmatch(r'(\s*)ip ospf area (\S+)', line)
    if m:
        return f'{m.group(1)}ip ospf 1 area {m.group(2)}'
    return line


def render_frr_conf(hostname, lines):
    head = f'frr defaults traditional\nhostname {hostname}\nservice integrated-vtysh-config\n!\n'
    return head + ('\n'.join(lines) + '\n!\n' if lines else '') + 'end\n'


def is_up(name):
    try:
        with open(f'/sys/class/net/{name}/flags') as f:
            return bool(int(f.read(), 16) & 1)
    except (OSError, ValueError):
        return False


class L3Plugin:
    def __init__(self, sw):
        self.sw = sw  # swcli自身（関数・値の参照用）
        self.routed_prev = set()
        self.forward_state = None
        self.dhcp_state = None
        self.acl_state = None
        self.last_route_check = 0.0
        self.frr_started = 0.0

    # ---- 設定の見え方 ----
    @staticmethod
    def routing(cfg):
        return bool(cfg.get('ip_routing'))

    @staticmethod
    def routes(cfg):
        return [r for r in cfg.get('routes', []) if isinstance(r, dict) and r.get('net') and r.get('nh')]

    @staticmethod
    def routed_ports(cfg):
        return {n for n, p in cfg.get('interfaces', {}).items() if p.get('routed')}

    # ---- running-config ----
    def global_lines(self, cfg):
        return ['ip routing', '!'] if self.routing(cfg) else []

    def routed_interface_lines(self, cfg, name):
        """ルーテッドポートなら、interface の下の行（スイッチポートの設定は出さない）。違えば None"""
        p = cfg.get('interfaces', {}).get(name, {})
        if not p.get('routed'):
            return None
        lines = [' no switchport']
        if p.get('description'):
            lines.append(f' description {p["description"]}')
        if p.get('address'):
            ip, prefix = p['address'].split('/')
            lines.append(f' ip address {ip} {self.sw.prefix_to_mask(int(prefix))}')
        else:
            lines.append(' no ip address')
        lines += self.interface_extra_lines(cfg, name)
        if p.get('shutdown'):
            lines.append(' shutdown')
        return lines

    def route_lines(self, cfg):
        out = []
        for r in self.routes(cfg):
            net = ipaddress.ip_network(r['net'])
            out.append(f'ip route {net.network_address} {net.netmask} {r["nh"]}')
        out = out + ['!'] if out else []
        out += self.acl_lines(cfg)
        # interface vlan N と ルーテッドポートの塊は、swcliの interface の下に出すので、ここでは出さない
        shown = {f'vlan{v}' for v in self.sw.svi_ids(cfg)} | self.routed_ports(cfg)
        run_kind = None  # 1行だけの設定（ip prefix-list …）は、Ciscoと同じく続けて出す
        for stanza in split_stanzas(cfg.get('frr', [])):
            if stanza[0].startswith('interface ') and stanza[0].split(None, 1)[1] in shown:
                continue
            kind = next((k for k in SINGLE_LINE_PREFIXES if stanza[0].startswith(k)), None) if len(stanza) == 1 else None
            if run_kind and kind != run_kind:
                out.append('!')
            run_kind = kind
            if kind:
                out.append(stanza[0])
                continue
            head = 'router ospf 1' if stanza[0] == 'router ospf' else stanza[0]
            words = stanza[0].split()
            proto = words[1] if words[0] == 'router' and len(words) > 1 else None
            out += [head] + [display_line(x, proto) for x in stanza[1:]] + ['!']
        if run_kind:
            out.append('!')
        return out

    @staticmethod
    def holder_of(cfg, dev):
        """SVI・ルーテッドポートの設定の辞書（helpers・acl_in・acl_out を持つ）"""
        m = re.fullmatch(r'vlan(\d+)', dev)
        return cfg.get('svi', {}).get(m.group(1), {}) if m else cfg.get('interfaces', {}).get(dev, {})

    def helpers_of(self, cfg, dev):
        return list(self.holder_of(cfg, dev).get('helpers', []))

    @staticmethod
    def acl_lines(cfg):
        """running-configのACL。番号付きは access-list N …、名前付きは ip access-list standard|extended NAME の下に番号付きで"""
        out = []
        for name in sorted(cfg.get('acls', {}), key=lambda n: (not n.isdigit(), int(n) if n.isdigit() else 0, n)):
            a = cfg['acls'][name]
            entries = sorted(a['entries'], key=lambda e: e['seq'])
            if acl.acl_kind_of_number(name):
                out += [f'access-list {name} {e["text"]}' for e in entries]
            else:
                out.append(f'ip access-list {a["type"]} {name}')
                out += [f' {e["seq"]} {e["text"]}' for e in entries]
                out.append('!')
        if out and out[-1] != '!':
            out.append('!')
        return out

    def show_acls(self, cfg, only=None):
        counters = {}
        dump = self.sw.sh('nft', 'list', 'table', 'ip', 'fnl_acl')
        if dump.returncode == 0:
            counters = acl.parse_counters(dump.stdout)
        out = []
        for name in sorted(cfg.get('acls', {}), key=lambda n: (not n.isdigit(), int(n) if n.isdigit() else 0, n)):
            if only and name != only:
                continue
            a = cfg['acls'][name]
            out.append(f'{a["type"].capitalize()} IP access list {name}')
            for e in sorted(a['entries'], key=lambda e: e['seq']):
                hits = counters.get((name, e['seq']), 0)
                out.append(f'    {e["seq"]} {e["text"]}' + (f' ({hits} matches)' if hits else ''))
        return '\n'.join(out)

    def interface_extra_lines(self, cfg, dev):
        """interface <dev> の下に出す設定：ip helper-address（swcliの設定）と、FRRの設定（ip ospf cost、vrrp 等）"""
        lines = []
        for direction in ('in', 'out'):
            name = self.holder_of(cfg, dev).get('acl_' + direction)
            if name:
                lines.append(f' ip access-group {name} {direction}')
        lines += [f' ip helper-address {h}' for h in self.helpers_of(cfg, dev)]
        for stanza in split_stanzas(cfg.get('frr', [])):
            if stanza[0] == f'interface {dev}':
                return lines + [display_line(x) for x in stanza[1:]]
        return lines

    # ---- コマンド ----
    def grammar(self, cli):
        sw = self.sw

        def set_routing(on):
            def fn(_args):
                def change(cfg):
                    if on:
                        cfg['ip_routing'] = True
                    else:
                        cfg.pop('ip_routing', None)

                cli.modify(change)

            return fn

        def route_args(a):
            net, err = parse_net(a[0], a[1], sw.mask_to_prefix, sw.is_ipv4)
            if err:
                print(err)
            return net

        def add_route(a):
            net = route_args(a)
            if net is None:
                return
            if not sw.is_ipv4(a[2]):
                print("% Invalid input detected at '^' marker.")
                return

            def change(cfg):
                routes = [r for r in cfg.get('routes', []) if not (r.get('net') == net and r.get('nh') == a[2])]
                routes.append({'net': net, 'nh': a[2]})
                cfg['routes'] = routes

            cli.modify(change)

        def del_route(a):
            net = route_args(a)
            if net is None:
                return

            def change(cfg):
                routes = [r for r in cfg.get('routes', []) if not (r.get('net') == net and (len(a) < 3 or r.get('nh') == a[2]))]
                if routes:
                    cfg['routes'] = routes
                else:
                    cfg.pop('routes', None)

            cli.modify(change)

        def single_port():
            if len(cli.ifaces) != 1:
                print('% This command works on one interface at a time.')
                return None
            return cli.ifaces[0]

        def no_switchport(_args):
            name = single_port()
            if name is None:
                return
            if name.startswith('po'):
                print('% Port-channel cannot be a routed port in this switch.')
                return
            if sw.member_of(cli.cfg(), name):
                print(f'% {name} is a member of a port-channel. Remove it first.')
                return
            cli.modify(lambda cfg: sw.port_cfg(cfg, name).update({'routed': True}))

        def switchport(_args):
            name = single_port()
            if name is None:
                return

            def change(cfg):
                p = sw.port_cfg(cfg, name)
                if p.pop('routed', None):
                    p.pop('address', None)

            cli.modify(change)

        def ip_address(a):
            name = single_port()
            if name is None:
                return
            if not sw.port_cfg(cli.cfg(), name).get('routed'):
                print('% This is a switchport. Use "no switchport" to make it a routed port first.')
                return
            prefix = sw.mask_to_prefix(a[1])
            if not sw.is_ipv4(a[0]) or prefix is None:
                print("% Invalid input detected at '^' marker.")
                return
            cli.modify(lambda cfg: sw.port_cfg(cfg, name).update({'address': f'{a[0]}/{prefix}'}))

        def no_ip_address(_args):
            name = single_port()
            if name is not None:
                cli.modify(lambda cfg: sw.port_cfg(cfg, name).pop('address', None))

        show_route = (['show', 'ip', 'route'], lambda a: print(self.show_ip_route(cli.cfg())), 'IP routing table')

        def frr_show(prefix):
            return lambda a: self.run_show(cli, prefix + (' ' + a[0] if a else ''))

        shows = [
            (['show', 'ip', 'route', '<line>'], frr_show('show ip route'), 'IP routing table'),
            (['show', 'ip', 'ospf'], frr_show('show ip ospf'), 'OSPF information'),
            (['show', 'ip', 'ospf', '<line>'], frr_show('show ip ospf'), 'OSPF information'),
            (['show', 'ip', 'bgp'], frr_show('show ip bgp'), 'BGP information'),
            (['show', 'ip', 'bgp', '<line>'], frr_show('show ip bgp'), 'BGP information'),
            (['show', 'ip', 'rip'], frr_show('show ip rip'), 'IP RIP information'),
            (['show', 'ip', 'protocols'], frr_show('show ip protocols'), 'IP routing protocol process parameters and statistics'),
            (['show', 'ip', 'prefix-list'], frr_show('show ip prefix-list'), 'List IP prefix lists'),
            (['show', 'ip', 'prefix-list', '<line>'], frr_show('show ip prefix-list'), 'List IP prefix lists'),
            (['show', 'vrrp'], frr_show('show vrrp'), 'VRRP information'),
            (['show', 'vrrp', 'brief'], frr_show('show vrrp'), 'VRRP information'),
            (['show', 'vrrp', '<line>'], frr_show('show vrrp'), 'VRRP information'),
            (['show', 'route-map'], frr_show('show route-map'), 'route-map information'),
            (['show', 'route-map', '<line>'], frr_show('show route-map'), 'route-map information'),
        ]

        def enter_router(proto):
            def fn(a):
                head = f'router {proto}' + (f' {a[0]}' if proto == 'bgp' and a else '')
                if self.run_config(cli, [], head):
                    cli.mode = 'router'
                    cli.frr_router = head
                    cli.frr_af = None

            return fn

        def leave_router(proto):
            def fn(a):
                self.run_config(cli, [], f'no router {proto}' + (f' {a[0]}' if proto == 'bgp' and a else ''))

            return fn

        def config_fallthrough(tokens):
            """Ciscoと同じく、router・route-map・ACLのモードの中でも、設定モードのコマンド（interface …、別の router …、ip route …）はそのまま通る"""
            try:
                node, args = sw.walk(cli.trees['config'], tokens)
            except sw.ParseError:
                return False
            if node is None or node.func is None:
                return False
            cli.mode = 'config'
            node.func(args)
            return True

        def router_line(a):
            tokens = a[0].split()
            if config_fallthrough(tokens):
                return
            words = cli.frr_router.split()
            proto = words[1] if words[0] == 'router' else None  # route-map の中は翻訳しない（Ciscoと同じ書き方）
            command, err = translate_router_command(proto, tokens, sw.is_ipv4, sw.mask_to_prefix)
            if err:
                print(err)
                return
            if command == '':
                return
            af = getattr(cli, 'frr_af', None)
            if command.startswith('address-family ') and not command.startswith('no '):
                # vtyshは1コマンドずつ起動し直すので、address-family の中にいることはこちらで覚える
                if self.run_config(cli, [cli.frr_router], command):
                    cli.frr_af = command
                return
            if command == 'exit-address-family':
                cli.frr_af = None
                return
            self.run_config(cli, [cli.frr_router] + ([af] if af else []), command)

        def router_exit(a):
            if getattr(cli, 'frr_af', None):
                cli.frr_af = None  # address-family から router に戻る
            else:
                cli.do_exit(a)

        def enter_route_map(a):
            # route-map NAME permit|deny [SEQ]（SEQ省略は10）
            head = f'route-map {a[0]} {a[1].lower()} {a[2] if len(a) > 2 else 10}'
            if self.run_config(cli, [], head):
                cli.mode = 'route-map'
                cli.frr_router = head
                cli.frr_af = None

        def frr_global(prefix, negate=False):
            def fn(a):
                self.run_config(cli, [], ('no ' if negate else '') + prefix + ' ' + a[0])

            return fn

        def iface_device():
            if cli.mode == 'svi':
                return f'vlan{cli.svi}'
            name = single_port()
            if name is None:
                return None
            if not sw.port_cfg(cli.cfg(), name).get('routed'):
                print('% This is a switchport. Use "no switchport" to make it a routed port first.')
                return None
            return name

        def iface_ospf(negate):
            def fn(a):
                dev = iface_device()
                if dev is None:
                    return
                command = translate_interface_command(['ip', 'ospf'] + a[0].split())
                self.run_config(cli, [f'interface {dev}'], ('no ' if negate else '') + command)

            return fn

        def iface_vrrp(negate):
            def fn(a):
                dev = iface_device()
                if dev is None:
                    return
                self.run_config(cli, [f'interface {dev}'], ('no ' if negate else '') + translate_vrrp_command(a[0].split()))

            return fn

        def helper_holder(cfg):
            """ip helper-address を持つ設定の辞書（SVIか、ルーテッドポート）。持てない場所なら None"""
            if cli.mode == 'svi':
                return cfg.setdefault('svi', {}).setdefault(str(cli.svi), {})
            name = single_port()
            if name is None:
                return None
            if not sw.port_cfg(cfg, name).get('routed'):
                print('% This is a switchport. Use "no switchport" to make it a routed port first.')
                return None
            return sw.port_cfg(cfg, name)

        def helper_add(a):
            if not sw.is_ipv4(a[0]):
                print("% Invalid input detected at '^' marker.")
                return

            def change(cfg):
                holder = helper_holder(cfg)
                if holder is not None and a[0] not in holder.get('helpers', []):
                    holder['helpers'] = holder.get('helpers', []) + [a[0]]

            cli.modify(change)

        def helper_del(a):
            def change(cfg):
                holder = helper_holder(cfg)
                if holder is None:
                    return
                left = [h for h in holder.get('helpers', []) if a and h != a[0]]
                if left:
                    holder['helpers'] = left
                else:
                    holder.pop('helpers', None)

            cli.modify(change)

        # ---- ACL（パケットフィルタ、acl.py。nftablesに変換する） ----
        def acl_error(e):
            text = str(e)
            print(text if text.startswith('%') else (text if text.startswith('Incomplete') or text.startswith('Invalid') else '% ' + text))

        def enter_acl(kind):
            def fn(a):
                name = a[0]
                existing = cli.cfg().get('acls', {}).get(name)
                if existing and existing['type'] != kind:
                    print(f'% Access-list {name} is {existing["type"]}; cannot change its type.')
                    return
                if not existing:
                    cli.modify(lambda cfg: cfg.setdefault('acls', {}).setdefault(name, {'type': kind, 'entries': []}))
                cli.mode = 'acl-std' if kind == 'standard' else 'acl-ext'
                cli.acl_name, cli.acl_kind = name, kind

            return fn

        def add_acl_entry(name, kind, tokens):
            seq = None
            if tokens and tokens[0].isdigit():
                seq, tokens = int(tokens[0]), tokens[1:]
            try:
                text = acl.entry_text(kind, tokens)
            except acl.AclError as e:
                acl_error(e)
                return
            entries = cli.cfg()['acls'][name]['entries']
            if seq is None:
                if any(e['text'] == text for e in entries):
                    print('% Duplicate sequence number')  # 同じ行はもう有る
                    return
                seq = (max((e['seq'] for e in entries), default=0) // acl.SEQ_STEP + 1) * acl.SEQ_STEP
            elif any(e['seq'] == seq for e in entries):
                print('% Duplicate sequence number')
                return

            def change(cfg):
                cfg['acls'][name]['entries'] = sorted(cfg['acls'][name]['entries'] + [{'seq': seq, 'text': text}], key=lambda e: e['seq'])

            cli.modify(change)

        def del_acl_entry(name, kind, tokens):
            if len(tokens) == 1 and tokens[0].isdigit():
                match = lambda e: e['seq'] == int(tokens[0])  # noqa: E731
            else:
                try:
                    text = acl.entry_text(kind, tokens)
                except acl.AclError as e:
                    acl_error(e)
                    return
                match = lambda e: e['text'] == text  # noqa: E731

            def change(cfg):
                cfg['acls'][name]['entries'] = [e for e in cfg['acls'][name]['entries'] if not match(e)]

            cli.modify(change)

        def acl_line(a):
            tokens = a[0].split()
            if config_fallthrough(tokens):
                return
            if tokens[0].lower() == 'remark':
                return
            if tokens[0].lower() == 'no':
                del_acl_entry(cli.acl_name, cli.acl_kind, tokens[1:])
            else:
                add_acl_entry(cli.acl_name, cli.acl_kind, tokens)

        def numbered_acl(a):
            kind = acl.acl_kind_of_number(a[0])
            if kind is None:
                print("% Invalid input detected at '^' marker.")
                return
            cli.modify(lambda cfg: cfg.setdefault('acls', {}).setdefault(a[0], {'type': kind, 'entries': []}))
            add_acl_entry(a[0], kind, a[1].split())

        def delete_acl(name):
            def change(cfg):
                cfg.get('acls', {}).pop(name, None)
                if not cfg.get('acls'):
                    cfg.pop('acls', None)

            cli.modify(change)

        def set_access_group(a):
            if a[1].lower() not in ('in', 'out'):
                print("% Invalid input detected at '^' marker.")
                return

            def change(cfg):
                holder = helper_holder(cfg)
                if holder is not None:
                    holder['acl_' + a[1].lower()] = a[0]

            cli.modify(change)

        def unset_access_group(a):
            direction = a[-1].lower()
            if direction not in ('in', 'out'):
                print("% Invalid input detected at '^' marker.")
                return

            def change(cfg):
                holder = helper_holder(cfg)
                if holder is not None and (len(a) == 1 or holder.get('acl_' + direction) == a[0]):
                    holder.pop('acl_' + direction, None)

            cli.modify(change)

        def show_access_lists(a):
            print(self.show_acls(cli.cfg(), a[0] if a else None))

        acl_shows = [(['show', 'access-lists'], show_access_lists, 'List access lists'),
                     (['show', 'access-lists', '<word>'], show_access_lists, 'List access lists'),
                     (['show', 'ip', 'access-lists'], show_access_lists, 'List IP access lists'),
                     (['show', 'ip', 'access-lists', '<word>'], show_access_lists, 'List IP access lists')]
        acl_entries = [
            (['ip', 'access-list', 'standard', '<word>'], enter_acl('standard'), 'Standard Access List'),
            (['ip', 'access-list', 'extended', '<word>'], enter_acl('extended'), 'Extended Access List'),
            (['no', 'ip', 'access-list', '<word>', '<word>'], lambda a: delete_acl(a[1]), 'Delete an access list'),
            (['access-list', '<word>', '<line>'], numbered_acl, 'Add an access list entry'),
            (['no', 'access-list', '<word>'], lambda a: delete_acl(a[0]), 'Delete an access list'),
        ]
        acl_mode_entries = [
            (['end'], cli.do_end, 'Exit from configure mode'),
            (['exit'], cli.do_exit, 'Exit from the current mode'),
            (['do', '<line>'], cli.do_do, 'To run exec commands in config mode'),
            (['<line>'], acl_line, 'Access list entry'),
        ]
        iface_entries = [
            (['ip', 'ospf', '<line>'], iface_ospf(False), 'OSPF interface commands'),
            (['no', 'ip', 'ospf', '<line>'], iface_ospf(True), 'OSPF interface commands'),
            (['vrrp', '<line>'], iface_vrrp(False), 'VRRP Interface configuration commands'),
            (['no', 'vrrp', '<line>'], iface_vrrp(True), 'VRRP Interface configuration commands'),
            (['ip', 'helper-address', '<ip>'], helper_add, 'Specify a destination address for UDP broadcasts (DHCP relay)'),
            (['no', 'ip', 'helper-address'], helper_del, 'Remove all helper addresses'),
            (['no', 'ip', 'helper-address', '<ip>'], helper_del, 'Remove a helper address'),
            (['ip', 'access-group', '<word>', '<word>'], set_access_group, 'Specify access control for packets (in|out)'),
            (['no', 'ip', 'access-group', '<word>'], unset_access_group, 'Remove the access group (in|out)'),
            (['no', 'ip', 'access-group', '<word>', '<word>'], unset_access_group, 'Remove the access group'),
        ]
        router_entries = [(['router', 'ospf'], enter_router('ospf'), 'Open Shortest Path First (OSPF)'),
                          (['router', 'ospf', '<word>'], enter_router('ospf'), 'Open Shortest Path First (OSPF)'),
                          (['no', 'router', 'ospf'], leave_router('ospf'), 'Remove OSPF'),
                          (['no', 'router', 'ospf', '<word>'], leave_router('ospf'), 'Remove OSPF'),
                          (['router', 'bgp', '<word>'], enter_router('bgp'), 'Border Gateway Protocol (BGP)'),
                          (['no', 'router', 'bgp', '<word>'], leave_router('bgp'), 'Remove BGP'),
                          (['router', 'rip'], enter_router('rip'), 'Routing Information Protocol (RIP)'),
                          (['no', 'router', 'rip'], leave_router('rip'), 'Remove RIP')]
        policy_entries = [
            (['route-map', '<word>', '<rmaction>'], enter_route_map, 'Create route-map or enter route-map command mode'),
            (['route-map', '<word>', '<rmaction>', '<word>'], enter_route_map, 'Sequence to insert to/delete from existing route-map entry'),
            (['no', 'route-map', '<line>'], frr_global('route-map', True), 'Delete route-map'),
            (['ip', 'prefix-list', '<line>'], frr_global('ip prefix-list'), 'Build a prefix list'),
            (['no', 'ip', 'prefix-list', '<line>'], frr_global('ip prefix-list', True), 'Delete a prefix list'),
            (['ip', 'as-path', '<line>'], frr_global('ip as-path'), 'BGP autonomous system path filter'),
            (['no', 'ip', 'as-path', '<line>'], frr_global('ip as-path', True), 'BGP autonomous system path filter'),
            (['ip', 'community-list', '<line>'], frr_global('ip community-list'), 'Add a community list entry'),
            (['no', 'ip', 'community-list', '<line>'], frr_global('ip community-list', True), 'Add a community list entry'),
        ]
        return {
            'exec': [show_route] + shows + acl_shows,
            'user': [show_route] + shows + acl_shows,
            'acl-std': acl_mode_entries,
            'acl-ext': acl_mode_entries,
            'route-map': [
                (['end'], cli.do_end, 'Exit from configure mode'),
                (['exit'], cli.do_exit, 'Exit from the current mode'),
                (['do', '<line>'], cli.do_do, 'To run exec commands in config mode'),
                (['<line>'], router_line, 'Route-map command'),
            ],
            'router': [
                (['end'], cli.do_end, 'Exit from configure mode'),
                (['exit'], router_exit, 'Exit from the current mode'),
                (['exit-address-family'], lambda a: setattr(cli, 'frr_af', None), 'Exit from Address Family configuration mode'),
                (['do', '<line>'], cli.do_do, 'To run exec commands in config mode'),
                (['<line>'], router_line, 'Routing protocol command'),
            ],
            'svi': iface_entries,
            'config': router_entries + policy_entries + acl_entries + [
                (['ip', 'routing'], set_routing(True), 'Enable IP routing'),
                (['no', 'ip', 'routing'], set_routing(False), 'Disable IP routing'),
                (['ip', 'route', '<ip>', '<mask>', '<ip>'], add_route, 'Establish static routes'),
                (['no', 'ip', 'route', '<ip>', '<mask>'], del_route, 'Remove static routes'),
                (['no', 'ip', 'route', '<ip>', '<mask>', '<ip>'], del_route, 'Remove a static route'),
            ],
            'interface': iface_entries + [
                (['no', 'switchport'], no_switchport, 'Make the interface a routed port'),
                (['switchport'], switchport, 'Set the interface to switchport (Layer 2) mode'),
                (['ip', 'address', '<ip>', '<mask>'], ip_address, 'Set the IP address of a routed port'),
                (['no', 'ip', 'address'], no_ip_address, 'Remove the IP address'),
            ],
        }

    def show_ip_route(self, cfg):
        if not self.routing(cfg):
            return NOT_ENABLED
        out = self.sw.sh('vtysh', '-c', 'show ip route', timeout=5)
        if out.returncode != 0:
            return '% Routing is starting. Try again in a few seconds.'
        return out.stdout.rstrip()

    # ---- FRRへの受け渡し（OSPF・BGP・RIP） ----
    def frr_ready(self, cli):
        """FRRにコマンドを渡せる状態か。渡せなければ理由を出す"""
        if not self.routing(cli.cfg()):
            print('% IP routing not enabled. Use "ip routing" first.')
            return False
        # ip routing の直後は、エージェントがFRRを起動し終えるまで数秒かかる。打ってすぐ失敗しないよう、最大10秒待つ
        deadline = time.time() + FRR_WAIT_SEC
        while not self.frr_ready_now():
            if time.time() > deadline:
                print('% Routing is starting. Try again in a few seconds.')
                return False
            time.sleep(0.5)
        return True

    def frr_ready_now(self):
        return self.frr_running() and self.sw.sh('vtysh', '-c', 'show version', timeout=5).returncode == 0

    def run_show(self, cli, command):
        if not self.frr_ready(cli):
            return
        out = self.sw.sh('vtysh', '-c', command, timeout=10)
        text = (out.stdout + out.stderr).rstrip()
        if text:
            print(text)

    def run_config(self, cli, contexts, command):
        """vtyshの設定モードで contexts に入ってから command を渡す。成功したら設定を保存用に写す。成功したか"""
        if not self.frr_ready(cli):
            return False
        args = ['vtysh', '-c', 'configure terminal']
        for c in contexts:
            args += ['-c', c]
        args += ['-c', command]
        out = self.sw.sh(*args, timeout=10)
        text = (out.stdout + out.stderr).strip()
        if text:
            print(text)
        self.store_frr(cli)
        return out.returncode == 0 and '%' not in text

    def store_frr(self, cli):
        """FRRの設定を、swcliの設定（frrキー）に写す。write memoryで startup.json に入り、FRRの起動のたびに書き戻される"""
        out = self.sw.sh('vtysh', '-c', 'show running-config', timeout=10)
        if out.returncode != 0:
            return
        lines = parse_frr_config(out.stdout)

        def change(cfg):
            if lines:
                cfg['frr'] = lines
            else:
                cfg.pop('frr', None)

        cli.modify(change)

    # ---- エージェント（1秒ごと） ----
    def tick(self, cfg):
        routing = self.routing(cfg)
        routed = self.routed_ports(cfg)
        self.sync_routed_ports(cfg, routed)
        self.sync_forwarding(routing, routed)
        self.sync_frr(cfg, routing)
        self.sync_vrrp(cfg, routing)
        self.sync_dhcp_helper(cfg)
        self.sync_acl(cfg)

    def sync_routed_ports(self, cfg, routed):
        sw = self.sw
        for name in routed:
            if not os.path.exists(f'/sys/class/net/{name}'):
                continue
            if os.path.exists(f'/sys/class/net/{name}/master'):
                sw.sh('ip', 'link', 'set', name, 'nomaster')
            want = cfg['interfaces'][name].get('address')
            have = [line.split()[3] for line in sw.sh('ip', '-4', '-o', 'addr', 'show', 'dev', name).stdout.splitlines() if len(line.split()) > 3]
            if have != ([want] if want else []):
                sw.sh('ip', '-4', 'addr', 'flush', 'dev', name)
                if want:
                    sw.sh('ip', 'addr', 'add', want, 'dev', name)
        # スイッチポートに戻したポートは、アドレスを消す（ブリッジへは sync_ports が入れ直す）
        for name in self.routed_prev - routed:
            if os.path.exists(f'/sys/class/net/{name}'):
                sw.sh('ip', '-4', 'addr', 'flush', 'dev', name)
        self.routed_prev = set(routed)

    @staticmethod
    def vrrp_instances(cfg):
        """FRRの設定にある VRRP のインスタンス {(デバイス, VRID): [仮想アドレス…]}。interface <dev> の下の `vrrp N …` から取る"""
        found = {}
        for stanza in split_stanzas(cfg.get('frr', [])):
            if not stanza[0].startswith('interface '):
                continue
            dev = stanza[0].split(None, 1)[1]
            for line in stanza[1:]:
                m = re.match(r'\s*vrrp (\d+)\b(?: ip (\d+\.\d+\.\d+\.\d+))?', line)
                if m:
                    ips = found.setdefault((dev, int(m.group(1))), [])
                    if m.group(2):
                        ips.append(m.group(2))
        return found

    @staticmethod
    def interface_address(cfg, dev):
        """SVI・ルーテッドポートの 'ip/プレフィックス'（仮想アドレスのプレフィックス長に使う）"""
        m = re.fullmatch(r'vlan(\d+)', dev)
        holder = cfg.get('svi', {}).get(m.group(1), {}) if m else cfg.get('interfaces', {}).get(dev, {})
        return holder.get('address')

    def sync_vrrp(self, cfg, routing):
        """FRRのvrrpdは、VRRPの仮想ルーター用のmacvlan（vrrp4-<ifindex>-<VRID>）を作ってくれない。
        設定に合わせてここで作り、要らなくなったものは消す（仮想アドレスはvrrpdがMasterの時だけ付ける）"""
        sw = self.sw
        want = {}
        if routing:
            for (dev, vrid), ips in self.vrrp_instances(cfg).items():
                try:
                    with open(f'/sys/class/net/{dev}/ifindex') as f:
                        want[f'vrrp4-{int(f.read())}-{vrid}'] = (dev, vrid, ips)
                except (OSError, ValueError):
                    continue  # まだデバイスが無い（SVIの作成待ち）
        have = [n for n in os.listdir('/sys/class/net') if re.fullmatch(r'vrrp4-\d+-\d+', n)]
        for name, (dev, vrid, ips) in want.items():
            if name not in have:
                sw.sh('ip', 'link', 'add', name, 'link', dev, 'addr', f'00:00:5e:00:01:{vrid:02x}', 'type', 'macvlan', 'mode', 'bridge')
            # 仮想アドレスはmacvlanに付けておく。Backupの間はvrrpdがmacvlanをprotodownにして無効にする
            base = self.interface_address(cfg, dev)
            prefix = base.split('/')[1] if base else '24'
            wanted = [f'{ip}/{prefix}' for ip in ips]
            current = [line.split()[3] for line in sw.sh('ip', '-4', '-o', 'addr', 'show', 'dev', name).stdout.splitlines() if len(line.split()) > 3]
            if sorted(current) != sorted(wanted):
                sw.sh('ip', '-4', 'addr', 'flush', 'dev', name)
                for addr in wanted:
                    sw.sh('ip', 'addr', 'add', addr, 'dev', name)
            if name not in have or not is_up(name):
                sw.sh('ip', 'link', 'set', name, 'up')
        for name in have:
            if name not in want:
                sw.sh('ip', 'link', 'del', name)

    def acl_applications(self, cfg):
        apps = []
        for vid, v in cfg.get('svi', {}).items():
            for direction in ('in', 'out'):
                if v.get('acl_' + direction):
                    apps.append((f'vlan{vid}', direction, v['acl_' + direction]))
        for name in self.routed_ports(cfg):
            for direction in ('in', 'out'):
                if cfg['interfaces'][name].get('acl_' + direction):
                    apps.append((name, direction, cfg['interfaces'][name]['acl_' + direction]))
        return apps

    def sync_acl(self, cfg):
        """ACLをnftablesの表(ip fnl_acl)にする。設定が変わった時だけ作り直す。存在しないACLを指す ip access-group は無視（Ciscoと同じく全部通す）"""
        try:
            script = acl.compile_nft(cfg.get('acls', {}), self.acl_applications(cfg))
        except acl.AclError as e:
            print(f'l3: ACLを変換できません: {e}', flush=True)
            return
        if script == self.acl_state:
            return
        self.sw.sh('nft', 'delete', 'table', 'ip', 'fnl_acl')
        if script:
            result = self._nft(script)
            if result is not None and result.returncode != 0:
                print(f'l3: nftables(ACL): {result.stderr.strip()}', flush=True)
        self.acl_state = script

    def sync_dhcp_helper(self, cfg):
        """ip helper-address のあるSVI・ルーテッドポートで受けたDHCP要求を、サーバーへ中継する（dhcp-helper）。
        サーバーは全インターフェースのものをまとめる（インターフェースごとに変える使い方は今は無い）"""
        sw = self.sw
        servers, ifaces = set(), set()
        for vid in sw.svi_ids(cfg):
            hs = self.helpers_of(cfg, f'vlan{vid}')
            if hs and os.path.exists(f'/sys/class/net/vlan{vid}'):
                servers |= set(hs)
                ifaces.add(f'vlan{vid}')
        for name in self.routed_ports(cfg):
            hs = self.helpers_of(cfg, name)
            if hs and os.path.exists(f'/sys/class/net/{name}'):
                servers |= set(hs)
                ifaces.add(name)
        want = (tuple(sorted(servers)), tuple(sorted(ifaces)))
        running = sw.sh('pidof', 'dhcp-helper').returncode == 0
        if want == self.dhcp_state and (running or not servers):
            return
        sw.sh('pkill', '-x', 'dhcp-helper')
        self.dhcp_state = want
        if not servers:
            return
        args = ['dhcp-helper']
        for server in want[0]:
            args += ['-s', server]
        for iface in want[1]:
            args += ['-i', iface]
        # デーモンが出力の口を握ったままになるので、パイプで待たない（run_initと同じ事情）
        try:
            code = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=10, start_new_session=True).returncode
        except (OSError, subprocess.TimeoutExpired):
            code = 124
        if code != 0:
            print('l3: dhcp-helperを起動できません', flush=True)

    def sync_forwarding(self, routing, routed):
        """no ip routing の間は、SVI・ルーテッドポートから入るパケットの転送を止める（コンテナの ip_forward は
        コンテナからは切り替えられないので、nftablesで止める）。ブリッジの中のL2転送には触れない"""
        state = (routing, tuple(sorted(routed)))
        if state == self.forward_state:
            return
        sw = self.sw
        sw.sh('nft', 'delete', 'table', 'inet', NFT_TABLE)
        if not routing:
            rules = ['iifname "vlan*" drop']
            if routed:
                rules.append('iifname { ' + ', '.join(f'"{n}"' for n in sorted(routed)) + ' } drop')
            body = '\n'.join(f'    {r}' for r in rules)
            script = (
                f'table inet {NFT_TABLE} {{\n  chain forward {{\n    type filter hook forward priority -10; policy accept;\n{body}\n  }}\n}}\n'
            )
            result = self._nft(script)
            if result is not None and result.returncode != 0:
                print(f'l3: nftables: {result.stderr.strip()}', flush=True)
        self.forward_state = state

    @staticmethod
    def _nft(script):
        try:
            return subprocess.run(['nft', '-f', '-'], input=script, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return None

    @staticmethod
    def run_init(action):
        """frrinit.sh を動かす。起動したデーモンが出力の口を握ったままになるので、出力はファイルに逃がして待たない
        （パイプで受けると、デーモンが閉じるまで30秒ほど固まる）"""
        try:
            with open(FRR_LOG, 'a') as log:
                return subprocess.run([FRR_INIT, action], stdout=log, stderr=log, stdin=subprocess.DEVNULL, timeout=30, start_new_session=True).returncode
        except (OSError, subprocess.TimeoutExpired):
            return 124

    def frr_running(self):
        return self.sw.sh('pidof', 'zebra').returncode == 0

    def start_frr(self, cfg):
        sw = self.sw
        self.frr_started = time.time()
        # デーモンの一覧は既定のまま（zebra・staticdは常に起動）。設定ファイルは起動のたびに作り直す
        with open(FRR_CONF, 'w') as f:
            f.write(render_frr_conf(cfg.get('hostname', 'switch'), cfg.get('frr', [])))
        if not os.path.exists(FRR_VTYSH_CONF):
            open(FRR_VTYSH_CONF, 'w').close()
        sw.sh('chown', 'frr:frr', FRR_CONF)
        sw.sh('chown', 'frr:frrvty', FRR_VTYSH_CONF)
        sw.sh('chmod', '640', FRR_CONF)
        if self.run_init('start') != 0:
            print(f'l3: FRRを起動できません（{FRR_LOG}）', flush=True)
        self.last_route_check = 0.0

    def stop_frr(self):
        sw = self.sw
        self.run_init('stop')
        # zebraが入れた経路はカーネルに残る。FRRが入れた経路（static=196、zebra=11）を消す
        for proto in ('196', '11'):
            sw.sh('ip', 'route', 'flush', 'proto', proto)

    def sync_frr(self, cfg, routing):
        running = self.frr_running()
        if not routing:
            if running:
                self.stop_frr()
            return
        if not running:
            # 起動に失敗し続けても、毎秒やり直さない（権限が足りない等）。やり直す前に、残ったwatchfrrを止める
            if time.time() - self.frr_started >= FRR_RETRY_SEC:
                if self.frr_started:
                    self.run_init('stop')
                self.start_frr(cfg)
            return
        if time.time() - self.last_route_check < ROUTE_CHECK_SEC:
            return
        self.last_route_check = time.time()
        self.sync_routes(cfg)

    def sync_frr_acls(self, cfg, running):
        """標準ACLを、FRRの access-list にも入れる（route-map の match ip address N や distribute-list で使うため）。
        FRRの設定（frrキー）には写さない。ここが持ち主"""
        want = set()
        for name, rows in acl.frr_access_list_lines(cfg.get('acls', {})).items():
            for seq, action, target in rows:
                want.add((name, seq, action, target))
        have = set()
        for line in running.splitlines():
            m = re.fullmatch(r'access-list (\S+) seq (\d+) (permit|deny) (\S+)', line.strip())
            if m:
                have.add((m.group(1), int(m.group(2)), m.group(3), m.group(4)))
        if have == want:
            return
        cmds = ['-c', 'configure terminal']
        for name, seq, action, target in sorted(have - want):
            cmds += ['-c', f'no access-list {name} seq {seq} {action} {target}']
        for name, seq, action, target in sorted(want - have):
            cmds += ['-c', f'access-list {name} seq {seq} {action} {target}']
        result = self.sw.sh('vtysh', *cmds, timeout=10)
        if result.returncode != 0:
            print(f'l3: FRRのaccess-listを入れられません: {(result.stderr or result.stdout).strip()}', flush=True)

    def sync_routes(self, cfg):
        """FRRの静的経路を、設定（routes）にそろえる（FRRが再起動して経路を失っていても戻る）"""
        sw = self.sw
        out = sw.sh('vtysh', '-c', 'show running-config', timeout=5)
        if out.returncode != 0:
            return
        have = set()
        for line in out.stdout.splitlines():
            m = re.fullmatch(r'ip route (\S+) (\S+)', line.strip())
            if m:
                have.add((m.group(1), m.group(2)))
        self.sync_frr_acls(cfg, out.stdout)
        want = {(r['net'], r['nh']) for r in self.routes(cfg)}
        if have == want:
            return
        cmds = ['-c', 'configure terminal']
        for net, nh in sorted(have - want):
            cmds += ['-c', f'no ip route {net} {nh}']
        for net, nh in sorted(want - have):
            cmds += ['-c', f'ip route {net} {nh}']
        result = sw.sh('vtysh', *cmds, timeout=10)
        if result.returncode != 0:
            print(f'l3: 静的経路を入れられません: {result.stderr.strip() or result.stdout.strip()}', flush=True)
