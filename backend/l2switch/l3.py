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

FRR_DAEMONS = '/etc/frr/daemons'
FRR_CONF = '/etc/frr/frr.conf'
FRR_VTYSH_CONF = '/etc/frr/vtysh.conf'
FRR_INIT = '/usr/lib/frr/frrinit.sh'
NFT_TABLE = 'fnl_l3'
ROUTE_CHECK_SEC = 5
FRR_RETRY_SEC = 15
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

KEEP_PREFIXES = ('router ', 'interface ', 'route-map ', 'ip prefix-list ', 'ipv6 prefix-list ', 'access-list ', 'ip as-path ', 'ip community-list ', 'bfd')
ROUTER_PROTOCOLS = ('ospf', 'bgp', 'rip')


def wildcard_to_prefix(wildcard, is_ipv4, mask_to_prefix):
    """0.0.0.255 → 24（ワイルドカードマスク）。連続していなければ None"""
    if not is_ipv4(wildcard):
        return None
    inverse = '.'.join(str(255 - int(x)) for x in wildcard.split('.'))
    return mask_to_prefix(inverse)


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
    return ('no ' if negate else '') + ' '.join(body), None


def translate_interface_command(tokens):
    """interface の中の ip ospf … をFRRのコマンドにする（ip ospf 1 area 0 → ip ospf area 0）"""
    body = list(tokens)
    if len(body) >= 5 and body[0:2] == ['ip', 'ospf'] and body[2].isdigit() and body[3].lower() == 'area':
        body = ['ip', 'ospf', 'area', body[4]]
    return ' '.join(body)


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


def display_line(line):
    """FRRの行をCiscoの書き方にして見せる（running-config用）"""
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


class L3Plugin:
    def __init__(self, sw):
        self.sw = sw  # swcli自身（関数・値の参照用）
        self.routed_prev = set()
        self.forward_state = None
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
        # interface vlan N と ルーテッドポートの塊は、swcliの interface の下に出すので、ここでは出さない
        shown = {f'vlan{v}' for v in self.sw.svi_ids(cfg)} | self.routed_ports(cfg)
        for stanza in split_stanzas(cfg.get('frr', [])):
            if stanza[0].startswith('interface ') and stanza[0].split(None, 1)[1] in shown:
                continue
            head = 'router ospf 1' if stanza[0] == 'router ospf' else stanza[0]
            out += [head] + [display_line(x) for x in stanza[1:]] + ['!']
        return out

    def interface_extra_lines(self, cfg, dev):
        """interface <dev> の下に出すFRRの設定（ip ospf cost 等）"""
        for stanza in split_stanzas(cfg.get('frr', [])):
            if stanza[0] == f'interface {dev}':
                return [display_line(x) for x in stanza[1:]]
        return []

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
        ]

        def enter_router(proto):
            def fn(a):
                head = f'router {proto}' + (f' {a[0]}' if proto == 'bgp' and a else '')
                if self.run_config(cli, [], head):
                    cli.mode = 'router'
                    cli.frr_router = head

            return fn

        def leave_router(proto):
            def fn(a):
                self.run_config(cli, [], f'no router {proto}' + (f' {a[0]}' if proto == 'bgp' and a else ''))

            return fn

        def router_line(a):
            tokens = a[0].split()
            # Ciscoと同じく、router モードの中でも設定モードのコマンド（interface …、別の router …、ip route …）はそのまま通る
            try:
                node, args = sw.walk(cli.trees['config'], tokens)
            except sw.ParseError:
                node = None
            if node is not None and node.func is not None:
                cli.mode = 'config'
                node.func(args)
                return
            proto = cli.frr_router.split()[1]
            command, err = translate_router_command(proto, tokens, sw.is_ipv4, sw.mask_to_prefix)
            if err:
                print(err)
                return
            self.run_config(cli, [cli.frr_router], command)

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

        iface_entries = [
            (['ip', 'ospf', '<line>'], iface_ospf(False), 'OSPF interface commands'),
            (['no', 'ip', 'ospf', '<line>'], iface_ospf(True), 'OSPF interface commands'),
        ]
        router_entries = [(['router', 'ospf'], enter_router('ospf'), 'Open Shortest Path First (OSPF)'),
                          (['router', 'ospf', '<word>'], enter_router('ospf'), 'Open Shortest Path First (OSPF)'),
                          (['no', 'router', 'ospf'], leave_router('ospf'), 'Remove OSPF'),
                          (['no', 'router', 'ospf', '<word>'], leave_router('ospf'), 'Remove OSPF'),
                          (['router', 'bgp', '<word>'], enter_router('bgp'), 'Border Gateway Protocol (BGP)'),
                          (['no', 'router', 'bgp', '<word>'], leave_router('bgp'), 'Remove BGP'),
                          (['router', 'rip'], enter_router('rip'), 'Routing Information Protocol (RIP)'),
                          (['no', 'router', 'rip'], leave_router('rip'), 'Remove RIP')]
        return {
            'exec': [show_route] + shows,
            'user': [show_route] + shows,
            'router': [
                (['end'], cli.do_end, 'Exit from configure mode'),
                (['exit'], cli.do_exit, 'Exit from the current mode'),
                (['do', '<line>'], cli.do_do, 'To run exec commands in config mode'),
                (['<line>'], router_line, 'Routing protocol command'),
            ],
            'svi': iface_entries,
            'config': router_entries + [
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
        if not self.frr_running():
            print('% Routing is starting. Try again in a few seconds.')
            return False
        return True

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
