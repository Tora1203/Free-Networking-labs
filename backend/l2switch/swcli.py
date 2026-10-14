#!/usr/bin/env python3
"""L2スイッチのCisco風CLIと、その設定をLinuxブリッジに反映するエージェント（2026-10-14）。

  swcli           対話CLI（コンソールで起動される。ルーターのvtyshと同じく終了しても再起動される）
  swcli --agent   設定（running-config）をbr0のVLAN設定に反映し続ける常駐プロセス（コンテナのメイン）

設定はJSONで持つ。
  running-config : /run/fnl-switch/running.json（起動時にstartup-configから作る。再起動で消える）
  startup-config : /etc/fnl-switch/startup.json（write memoryで保存。コンテナを作り直すと消える）

VLANの意味はCiscoに合わせる：
  - 何も設定していないポートは access VLAN 1
  - access：指定VLANのタグなしポート
  - trunk：allowed vlan（既定は全VLAN）をタグ付きで通し、native vlan（既定1）だけタグなしで通す
"""
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time

RUN_DIR = '/run/fnl-switch'
RUNNING = f'{RUN_DIR}/running.json'
STARTUP_DIR = '/etc/fnl-switch'
STARTUP = f'{STARTUP_DIR}/startup.json'
BRIDGE = 'br0'
ALL_VLANS = list(range(1, 4095))


# ---------------------------------------------------------------------------
# 設定の読み書き
# ---------------------------------------------------------------------------

def default_config():
    return {'hostname': socket.gethostname(), 'vlans': {'1': 'default'}, 'interfaces': {}}


def load(path):
    try:
        with open(path) as f:
            cfg = json.load(f)
        cfg.setdefault('hostname', socket.gethostname())
        cfg.setdefault('vlans', {'1': 'default'})
        cfg.setdefault('interfaces', {})
        return cfg
    except (OSError, ValueError):
        return default_config()


def save(path, cfg):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f:
        json.dump(cfg, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def port_cfg(cfg, name):
    return cfg['interfaces'].setdefault(name, {})


def port_view(cfg, name):
    """既定値を埋めたポート設定"""
    p = cfg['interfaces'].get(name, {})
    return {
        'mode': p.get('mode', 'access'),
        'access_vlan': p.get('access_vlan', 1),
        'allowed': p.get('allowed', 'all'),
        'native': p.get('native', 1),
        'shutdown': p.get('shutdown', False),
        'description': p.get('description', ''),
    }


def iface_key(name):
    m = re.match(r'eth(\d+)$', name)
    return int(m.group(1)) if m else 0


def system_ports():
    try:
        names = os.listdir('/sys/class/net')
    except OSError:
        return []
    return sorted((n for n in names if re.fullmatch(r'eth[1-9]\d*', n)), key=iface_key)


def all_ports(cfg):
    return sorted(set(system_ports()) | set(cfg['interfaces']), key=iface_key)


# ---------------------------------------------------------------------------
# VLANリストの表記（Cisco風：1,10-20）
# ---------------------------------------------------------------------------

def parse_vlan_list(text):
    vlans = set()
    for part in text.split(','):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r'(\d+)(?:-(\d+))?', part)
        if not m:
            return None
        a = int(m.group(1))
        b = int(m.group(2) or a)
        if not (1 <= a <= b <= 4094):
            return None
        vlans.update(range(a, b + 1))
    return sorted(vlans) if vlans else None


def format_vlan_list(vlans):
    if vlans == 'all':
        return 'ALL'
    vlans = sorted(vlans)
    if not vlans:
        return 'none'
    out = []
    start = prev = vlans[0]
    for v in vlans[1:] + [None]:
        if v is not None and v == prev + 1:
            prev = v
            continue
        out.append(str(start) if start == prev else f'{start}-{prev}')
        if v is not None:
            start = prev = v
    return ','.join(out)


# ---------------------------------------------------------------------------
# エージェント：running-config → br0
# ---------------------------------------------------------------------------

def sh(*args):
    return subprocess.run(args, capture_output=True, text=True)


def desired_vlans(p):
    """ポートの (vid, pvid/untagged) の集合"""
    if p['mode'] == 'trunk':
        allowed = ALL_VLANS if p['allowed'] == 'all' else p['allowed']
        return {(v, v == p['native']) for v in allowed}
    return {(p['access_vlan'], True)}


def current_vlans():
    r = sh('bridge', '-j', 'vlan', 'show')
    result = {}
    try:
        for entry in json.loads(r.stdout or '[]'):
            vids = set()
            for v in entry.get('vlans', []):
                flags = v.get('flags', [])
                untagged = 'PVID' in flags and 'Egress Untagged' in flags
                end = v.get('vlanEnd', v['vlan'])
                for vid in range(v['vlan'], end + 1):
                    vids.add((vid, untagged))
            result[entry['ifname']] = vids
    except (ValueError, KeyError):
        pass
    return result


def apply_port(name, p):
    want = desired_vlans(p)
    sh('bridge', 'vlan', 'del', 'dev', name, 'vid', '1-4094')
    tagged = sorted(v for v, untagged in want if not untagged)
    for v, untagged in want:
        if untagged:
            sh('bridge', 'vlan', 'add', 'dev', name, 'vid', str(v), 'pvid', 'untagged')
    # 連続範囲はまとめて追加する（全VLAN許可のトランクで4094回コマンドを打たないため）
    if tagged:
        for rng in format_vlan_list(tagged).split(','):
            sh('bridge', 'vlan', 'add', 'dev', name, 'vid', rng)


def agent():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    os.makedirs(RUN_DIR, exist_ok=True)
    if not os.path.exists(RUNNING):
        save(RUNNING, load(STARTUP) if os.path.exists(STARTUP) else default_config())
    while True:
        try:
            if not os.path.exists(f'/sys/class/net/{BRIDGE}'):
                sh('ip', 'link', 'add', BRIDGE, 'type', 'bridge', 'vlan_filtering', '1')
            sh('ip', 'link', 'set', BRIDGE, 'up')
            cfg = load(RUNNING)
            current = current_vlans()
            for name in system_ports():
                p = port_view(cfg, name)
                if not os.path.exists(f'/sys/class/net/{name}/master'):
                    sh('ip', 'link', 'set', name, 'master', BRIDGE)
                    current[name] = set()
                operstate_up = open(f'/sys/class/net/{name}/flags').read().strip()
                is_up = int(operstate_up, 16) & 1
                if p['shutdown'] and is_up:
                    sh('ip', 'link', 'set', name, 'down')
                elif not p['shutdown'] and not is_up:
                    sh('ip', 'link', 'set', name, 'up')
                if current.get(name, set()) != desired_vlans(p):
                    apply_port(name, p)
        except Exception as e:  # 1回の失敗で止まらないように
            print(f'agent: {e}', file=sys.stderr)
        time.sleep(1)


# ---------------------------------------------------------------------------
# show系
# ---------------------------------------------------------------------------

def link_status(name, p):
    if p['shutdown']:
        return 'disabled'
    try:
        with open(f'/sys/class/net/{name}/carrier') as f:
            return 'connected' if f.read().strip() == '1' else 'notconnect'
    except OSError:
        return 'notconnect'


def show_running(cfg):
    lines = ['Building configuration...', '', 'Current configuration:', '!', f'hostname {cfg["hostname"]}', '!']
    for vid in sorted(cfg['vlans'], key=int):
        if vid == '1':
            continue
        lines.append(f'vlan {vid}')
        name = cfg['vlans'][vid]
        if name and name != f'VLAN{int(vid):04d}':
            lines.append(f' name {name}')
        lines.append('!')
    for name in all_ports(cfg):
        p = port_view(cfg, name)
        lines.append(f'interface {name}')
        if p['description']:
            lines.append(f' description {p["description"]}')
        if p['mode'] == 'trunk':
            lines.append(' switchport mode trunk')
            if p['native'] != 1:
                lines.append(f' switchport trunk native vlan {p["native"]}')
            if p['allowed'] != 'all':
                lines.append(f' switchport trunk allowed vlan {format_vlan_list(p["allowed"])}')
        else:
            lines.append(' switchport mode access')
            if p['access_vlan'] != 1:
                lines.append(f' switchport access vlan {p["access_vlan"]}')
        if p['shutdown']:
            lines.append(' shutdown')
        lines.append('!')
    lines.append('end')
    return '\n'.join(lines)


def show_vlan_brief(cfg):
    out = [f'{"VLAN":<5}{"Name":<33}{"Status":<10}Ports', '---- ' + '-' * 32 + ' --------- ' + '-' * 30]
    for vid in sorted(cfg['vlans'], key=int):
        ports = [n for n in all_ports(cfg) if port_view(cfg, n)['mode'] == 'access' and port_view(cfg, n)['access_vlan'] == int(vid)]
        out.append(f'{vid:<5}{cfg["vlans"][vid]:<33}{"active":<10}{", ".join(ports)}')
    return '\n'.join(out)


def show_interfaces_status(cfg):
    out = [f'{"Port":<9}{"Name":<19}{"Status":<13}Vlan']
    for name in all_ports(cfg):
        p = port_view(cfg, name)
        vlan = 'trunk' if p['mode'] == 'trunk' else str(p['access_vlan'])
        out.append(f'{name:<9}{p["description"][:18]:<19}{link_status(name, p):<13}{vlan}')
    return '\n'.join(out)


def show_interfaces_trunk(cfg):
    trunks = [n for n in all_ports(cfg) if port_view(cfg, n)['mode'] == 'trunk']
    if not trunks:
        return ''
    out = [f'{"Port":<9}{"Mode":<13}{"Status":<13}Native vlan']
    for n in trunks:
        p = port_view(cfg, n)
        out.append(f'{n:<9}{"on":<13}{"trunking" if link_status(n, p) == "connected" else link_status(n, p):<13}{p["native"]}')
    out += ['', f'{"Port":<9}Vlans allowed on trunk']
    for n in trunks:
        p = port_view(cfg, n)
        out.append(f'{n:<9}{"1-4094" if p["allowed"] == "all" else format_vlan_list(p["allowed"])}')
    return '\n'.join(out)


def show_mac(cfg):
    r = sh('bridge', '-j', 'fdb', 'show', 'br', BRIDGE)
    rows = []
    try:
        for e in json.loads(r.stdout or '[]'):
            flags = e.get('flags', [])
            state = e.get('state', '')
            if 'self' in flags or state == 'permanent' or e.get('ifname') == BRIDGE:
                continue
            rows.append((e.get('vlan', 1), e.get('mac', ''), e.get('ifname', '')))
    except ValueError:
        pass
    out = ['          Mac Address Table', '-------------------------------------------', '',
           f'{"Vlan":<8}{"Mac Address":<20}{"Type":<12}Ports', '----    -----------         --------    -----']
    for vlan, mac, port in sorted(rows, key=lambda r: (r[0], r[1])):
        out.append(f'{vlan:<8}{mac:<20}{"DYNAMIC":<12}{port}')
    out.append(f'Total Mac Addresses for this criterion: {len(rows)}')
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# コマンドの文法（Cisco風）。表示メッセージは英語（2026-10-14：端末で日本語が文字化けしたため）
# ---------------------------------------------------------------------------
# 文法は「キーワード／引数」の木。各キーワードは一意に決まる範囲で省略でき（conf t、int e1、sw mo acc）、
# 完全一致のキーワードは前方一致より優先する。キーワードに一致しない時だけ引数として解釈する。
#   <vlan>  1-4094   <vlans> VLANリスト(1,10-20)   <iface> eth1（e1 / eth 1 / Ethernet1も可）
#   <ifaces> eth1-3,eth5   <word> 1語   <line> 行の残り全部

IFACE_WORD = re.compile(r'e(t(h(e(r(n(e(t)?)?)?)?)?)?)?', re.I)


def norm_iface(tok):
    m = re.fullmatch(r'e(?:t(?:h(?:e(?:r(?:n(?:e(?:t)?)?)?)?)?)?)?(\d+)', tok, re.I)
    return f'eth{int(m.group(1))}' if m and int(m.group(1)) >= 1 else None


def norm_iface_range(tok):
    names = []
    for part in tok.split(','):
        m = re.fullmatch(r'(?:e(?:t(?:h(?:e(?:r(?:n(?:e(?:t)?)?)?)?)?)?)?)?(\d+)(?:-(?:e(?:t(?:h)?)?)?(\d+))?', part, re.I)
        if not m:
            return None
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        if not (1 <= a <= b <= 64):
            return None
        names += [f'eth{i}' for i in range(a, b + 1)]
    return names or None


def tokenize(line):
    """空白で分け、`eth 1` / `ethernet 1-3` のように名前と番号が離れていたら1語にまとめる"""
    raw = line.split()
    tokens = []
    i = 0
    while i < len(raw):
        tok = raw[i]
        if IFACE_WORD.fullmatch(tok) and i + 1 < len(raw) and re.match(r'\d', raw[i + 1]):
            tok += raw[i + 1]
            i += 1
        tokens.append(tok)
        i += 1
    return tokens


ARG_CHECK = {
    '<vlan>': lambda t: t.isdigit() and 1 <= int(t) <= 4094,
    '<vlans>': lambda t: parse_vlan_list(t) is not None,
    '<iface>': lambda t: norm_iface(t) is not None,
    '<ifaces>': lambda t: norm_iface_range(t) is not None,
    '<word>': lambda t: True,
    '<line>': lambda t: True,
}
ARG_HELP = {
    '<vlan>': ('<1-4094>', 'VLAN ID'),
    '<vlans>': ('WORD', 'VLAN IDs of the allowed VLANs (e.g. 10,20,30-40)'),
    '<iface>': ('ethN', 'Interface (e.g. eth1)'),
    '<ifaces>': ('WORD', 'Interface range (e.g. eth1-3,eth5)'),
    '<word>': ('WORD', ''),
    '<line>': ('LINE', ''),
}
KEYWORD_HELP = {
    'configure': 'Enter configuration mode', 'terminal': 'Configure from the terminal',
    'copy': 'Copy from one file to another', 'show': 'Show running system information',
    'write': 'Write running configuration to memory', 'memory': 'Write to NV memory',
    'enable': 'Turn on privileged commands', 'interfaces': 'Interface status and configuration',
    'mac': 'MAC configuration', 'address-table': 'MAC forwarding table', 'mac-address-table': 'MAC forwarding table',
    'vlan': 'VLAN commands', 'interface': 'Select an interface to configure', 'range': 'Interface range command',
    'switchport': 'Set switching mode characteristics', 'mode': 'Set trunking mode of the interface',
    'access': 'Set access mode characteristics of the interface', 'trunk': 'Set trunking characteristics of the interface',
    'allowed': 'Set allowed VLAN characteristics when interface is in trunking mode',
    'native': 'Set trunking native characteristics when interface is in trunking mode',
    'no': 'Negate a command or set its defaults', 'do': 'To run exec commands in config mode',
    'hostname': 'Set system\'s network name', 'name': 'Ascii name of the VLAN', 'description': 'Interface specific description',
    'shutdown': 'Shutdown the selected interface', 'end': 'Exit from configure mode',
    'exit': 'Exit from the current mode', 'quit': 'Exit from the EXEC', 'running-config': 'Current operating configuration',
    'startup-config': 'Contents of startup configuration', 'status': 'Show interface line status',
    'brief': 'VTP all VLAN status in brief', 'add': 'add VLANs to the current list',
    'remove': 'remove VLANs from the current list', 'all': 'all VLANs', 'none': 'no VLANs',
}


class Node:
    """文法の木の1要素。children：キーワード/引数 → Node、func：ここで終わるコマンドの処理"""
    def __init__(self):
        self.children = {}
        self.func = None
        self.help = ''


def build_tree(entries):
    root = Node()
    for pattern, func, help_ in entries:
        node = root
        for elem in pattern:
            node = node.children.setdefault(elem, Node())
        node.func = func
        node.help = help_
    return root


class ParseError(Exception):
    def __init__(self, message, pos=None):
        super().__init__(message)
        self.pos = pos  # 何語目でエラーになったか（^の位置）


def match_children(node, tok):
    """tokに一致する子。キーワードの完全一致 > キーワードの前方一致（一意なら）> 引数"""
    low = tok.lower()
    keywords = [k for k in node.children if not k.startswith('<')]
    if low in keywords:
        return [(low, node.children[low])]
    prefixed = [k for k in keywords if k.startswith(low)]
    if prefixed:
        return [(k, node.children[k]) for k in prefixed]
    return [(k, c) for k, c in node.children.items() if k.startswith('<') and ARG_CHECK[k](tok)]


def walk(root, tokens):
    """tokensを木に沿って辿る。(最後のNode, 引数のリスト)。曖昧・不正ならParseError"""
    node = root
    args = []
    for i, tok in enumerate(tokens):
        if '<line>' in node.children and not any(k for k, _ in match_children(node, tok) if not k.startswith('<')):
            args.append(' '.join(tokens[i:]))
            return node.children['<line>'], args
        found = match_children(node, tok)
        if not found:
            raise ParseError('% Invalid input detected at \'^\' marker.', i)
        if len(found) > 1:
            raise ParseError(f'% Ambiguous command:  "{" ".join(tokens[: i + 1])}"')
        key, node = found[0]
        if key.startswith('<'):
            args.append(tok)
    return node, args


class Cli:
    def __init__(self):
        self.mode = 'exec'
        self.ifaces = []  # interfaceモードの対象
        self.vlan = None  # vlanモードの対象
        self.trees = {mode: build_tree(entries) for mode, entries in self.build_grammar().items()}

    # ---- 文法 ----
    def build_grammar(self):
        p = lambda f: (lambda a: print(f(self.cfg())))  # noqa: E731
        show = [
            (['show', 'running-config'], p(show_running), 'Current operating configuration'),
            (['show', 'startup-config'], self.show_startup, 'Contents of startup configuration'),
            (['show', 'vlan'], p(show_vlan_brief), 'VTP VLAN status'),
            (['show', 'vlan', 'brief'], p(show_vlan_brief), 'VTP all VLAN status in brief'),
            (['show', 'interfaces'], p(show_interfaces_status), 'Interface status and configuration'),
            (['show', 'interfaces', 'status'], p(show_interfaces_status), 'Show interface line status'),
            (['show', 'interfaces', 'trunk'], p(show_interfaces_trunk), 'Show interface trunk information'),
            (['show', 'mac', 'address-table'], p(show_mac), 'MAC forwarding table'),
            (['show', 'mac-address-table'], p(show_mac), 'MAC forwarding table'),
        ]
        common_cfg = [
            (['end'], self.do_end, 'Exit from configure mode'),
            (['exit'], self.do_exit, 'Exit from the current mode'),
            (['do', '<line>'], self.do_do, 'To run exec commands in config mode'),
        ]
        return {
            'exec': show + [
                (['configure'], self.do_conf, 'Enter configuration mode'),
                (['configure', 'terminal'], self.do_conf, 'Configure from the terminal'),
                (['enable'], lambda a: None, 'Turn on privileged commands'),
                (['write'], self.do_write, 'Write running configuration to memory'),
                (['write', 'memory'], self.do_write, 'Write to NV memory'),
                (['copy', 'running-config', 'startup-config'], self.do_write, 'Copy to startup configuration'),
                (['exit'], self.do_logout, 'Exit from the EXEC'),
                (['quit'], self.do_logout, 'Exit from the EXEC'),
            ],
            'config': common_cfg + [
                (['hostname', '<word>'], self.do_hostname, "Set system's network name"),
                (['interface', '<iface>'], self.do_interface, 'Select an interface to configure'),
                (['interface', 'range', '<ifaces>'], self.do_interface_range, 'Interface range command'),
                (['vlan', '<vlans>'], self.do_vlan, 'Vlan commands'),
                (['no', 'vlan', '<vlans>'], self.do_no_vlan, 'Delete VLANs'),
            ],
            'vlan': common_cfg + [
                (['name', '<word>'], self.do_vlan_name, 'Ascii name of the VLAN'),
                (['no', 'name'], self.do_vlan_no_name, 'Reset the VLAN name'),
            ],
            'interface': common_cfg + [
                (['switchport', 'mode', 'access'], lambda a: self.set_port(mode='access'), 'Set trunking mode to ACCESS unconditionally'),
                (['switchport', 'mode', 'trunk'], lambda a: self.set_port(mode='trunk'), 'Set trunking mode to TRUNK unconditionally'),
                (['switchport', 'access', 'vlan', '<vlan>'], self.do_access_vlan, 'Set VLAN when interface is in access mode'),
                (['switchport', 'trunk', 'allowed', 'vlan', '<vlans>'], self.do_allowed, 'Set allowed VLANs'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'add', '<vlans>'], self.do_allowed_add, 'add VLANs to the current list'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'remove', '<vlans>'], self.do_allowed_remove, 'remove VLANs from the current list'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'all'], lambda a: self.set_port(allowed=None), 'all VLANs'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'none'], lambda a: self.set_port(allowed=[]), 'no VLANs'),
                (['switchport', 'trunk', 'native', 'vlan', '<vlan>'], self.do_native, 'Set native VLAN when interface is in trunking mode'),
                (['no', 'switchport', 'mode'], lambda a: self.set_port(mode=None), 'Reset the mode to access'),
                (['no', 'switchport', 'access', 'vlan'], lambda a: self.set_port(access_vlan=None), 'Reset the access VLAN to 1'),
                (['no', 'switchport', 'trunk', 'allowed', 'vlan'], lambda a: self.set_port(allowed=None), 'Allow all VLANs'),
                (['no', 'switchport', 'trunk', 'native', 'vlan'], lambda a: self.set_port(native=None), 'Reset the native VLAN to 1'),
                (['shutdown'], lambda a: self.set_port(shutdown=True), 'Shutdown the selected interface'),
                (['no', 'shutdown'], lambda a: self.set_port(shutdown=None), 'Enable the selected interface'),
                (['description', '<line>'], self.do_description, 'Interface specific description'),
                (['no', 'description'], lambda a: self.set_port(description=None), 'Remove the description'),
            ],
        }

    def parse(self, tokens):
        """今のモードで解釈する。interface/vlanモードで通らなければ、Ciscoと同じく設定モードの
        コマンド（別のinterfaceへの移動等）として解釈し直す。(モード, Node, 引数)"""
        try:
            node, args = walk(self.trees[self.mode], tokens)
            return self.mode, node, args
        except ParseError:
            if self.mode not in ('interface', 'vlan'):
                raise
            try:
                node, args = walk(self.trees['config'], tokens)
                return 'config', node, args
            except ParseError:
                pass
            raise

    # ---- ? ヘルプ ----
    def help(self, line):
        tokens = tokenize(line)
        partial = bool(tokens) and not line.endswith(' ')
        prefix = tokens[:-1] if partial else tokens
        try:
            _, node, _ = self.parse(prefix)
        except ParseError as e:
            print(e)
            return
        rows = []
        for key, child in node.children.items():
            if key == '<line>' and node.func is None and not partial:
                rows.append(ARG_HELP[key])
                continue
            if partial:
                tok = tokens[-1]
                if key.startswith('<'):
                    if not ARG_CHECK[key](tok):
                        continue
                elif not key.startswith(tok.lower()):
                    continue
            if key.startswith('<'):
                rows.append(ARG_HELP[key])
            else:
                rows.append((key, child.help if child.func and not child.children else KEYWORD_HELP.get(key, child.help)))
        if partial:
            # 「conf?」のように語の途中で?を打った時は、一致するキーワード名だけを並べる（Ciscoと同じ）
            names = [label for label, _ in rows]
            print('  '.join(names) if names else '% Unrecognized command')
            return
        if node.func is not None and node is not self.trees[self.mode]:
            rows.append(('<cr>', ''))
        if not rows:
            print('% Unrecognized command')
        for label, desc in sorted(rows, key=lambda r: (r[0].startswith('<') and r[0] != '<cr>', r[0] == '<cr>', r[0])):
            print(f'  {label:<18}{desc}')

    # ---- Tab補完 ----
    def complete(self, text, state):
        import readline
        if state == 0:
            line = readline.get_line_buffer()[: readline.get_begidx()]
            self._matches = []
            try:
                _, node, _ = self.parse(tokenize(line))
            except ParseError:
                return None
            opts = [k for k in node.children if not k.startswith('<') and k.startswith(text.lower())]
            # インターフェース名も補完する（int e<Tab> → eth、eth<Tab> → eth1 eth2 ...）
            if '<iface>' in node.children or '<ifaces>' in node.children:
                ports = all_ports(self.cfg())
                opts += [p for p in ports if p.startswith(text.lower())]
            # 一意に決まる時だけ補完し、空白を足す（Ciscoと同じく、曖昧なら2回目のTabで候補一覧）
            self._matches = sorted(set(opts))
        if state < len(self._matches):
            m = self._matches[state]
            return m + ' ' if len(self._matches) == 1 else m
        return None

    # ---- 設定の操作 ----
    def cfg(self):
        return load(RUNNING)

    def modify(self, fn):
        cfg = self.cfg()
        fn(cfg)
        save(RUNNING, cfg)

    def set_port(self, **changes):
        def fn(cfg):
            for name in self.ifaces:
                p = port_cfg(cfg, name)
                for k, v in changes.items():
                    if v is None:
                        p.pop(k, None)
                    else:
                        p[k] = v
                if not p:
                    cfg['interfaces'].pop(name, None)
        self.modify(fn)

    def show_startup(self, a):
        if not os.path.exists(STARTUP):
            print('startup-config is not present')
        else:
            print(show_running(load(STARTUP)))

    def do_conf(self, a):
        print('Enter configuration commands, one per line.  End with CNTL/Z.')
        self.mode = 'config'

    def do_write(self, a):
        print('Building configuration...')
        save(STARTUP, self.cfg())
        print('[OK]')

    def do_logout(self, a):
        raise EOFError

    def do_end(self, a):
        self.mode = 'exec'

    def do_exit(self, a):
        self.mode = 'config' if self.mode in ('interface', 'vlan') else 'exec'

    def do_do(self, a):
        saved = self.mode
        self.mode = 'exec'
        try:
            self.execute(a[0])
        finally:
            if self.mode == 'exec':
                self.mode = saved

    def do_hostname(self, a):
        self.modify(lambda cfg: cfg.__setitem__('hostname', a[0]))

    def do_interface(self, a):
        self.ifaces = [norm_iface(a[0])]
        self.mode = 'interface'

    def do_interface_range(self, a):
        self.ifaces = norm_iface_range(a[0])
        self.mode = 'interface'

    def do_vlan(self, a):
        vlans = parse_vlan_list(a[0])
        self.modify(lambda cfg: [cfg['vlans'].setdefault(str(v), 'default' if v == 1 else f'VLAN{v:04d}') for v in vlans])
        self.vlan = vlans
        self.mode = 'vlan'

    def do_no_vlan(self, a):
        vlans = parse_vlan_list(a[0])
        if 1 in vlans:
            print('% Default VLAN 1 may not be deleted.')
            return
        self.modify(lambda cfg: [cfg['vlans'].pop(str(v), None) for v in vlans])

    def do_vlan_name(self, a):
        self.modify(lambda cfg: [cfg['vlans'].__setitem__(str(v), a[0]) for v in self.vlan])

    def do_vlan_no_name(self, a):
        self.modify(lambda cfg: [cfg['vlans'].__setitem__(str(v), 'default' if v == 1 else f'VLAN{v:04d}') for v in self.vlan])

    def do_access_vlan(self, a):
        v = int(a[0])
        if str(v) not in self.cfg()['vlans']:
            print(f'% Access VLAN does not exist. Creating vlan {v}')
        self.set_port(access_vlan=None if v == 1 else v)
        self.modify(lambda cfg: cfg['vlans'].setdefault(str(v), f'VLAN{v:04d}'))

    def current_allowed(self, cfg, name):
        allowed = port_view(cfg, name)['allowed']
        return set(ALL_VLANS) if allowed == 'all' else set(allowed)

    def do_allowed(self, a):
        self.set_port(allowed=parse_vlan_list(a[0]))

    def do_allowed_add(self, a):
        add = set(parse_vlan_list(a[0]))

        def fn(cfg):
            for name in self.ifaces:
                v = sorted(self.current_allowed(cfg, name) | add)
                port_cfg(cfg, name)['allowed'] = v
                if v == ALL_VLANS:
                    port_cfg(cfg, name).pop('allowed')
        self.modify(fn)

    def do_allowed_remove(self, a):
        rem = set(parse_vlan_list(a[0]))
        self.modify(lambda cfg: [port_cfg(cfg, n).__setitem__('allowed', sorted(self.current_allowed(cfg, n) - rem)) for n in self.ifaces])

    def do_native(self, a):
        v = int(a[0])
        self.set_port(native=None if v == 1 else v)

    def do_description(self, a):
        self.set_port(description=a[0])

    # ---- 実行ループ ----
    def prompt(self):
        host = self.cfg()['hostname']
        return {'exec': f'{host}#', 'config': f'{host}(config)#', 'interface': f'{host}(config-if)#',
                'vlan': f'{host}(config-vlan)#'}[self.mode]

    def execute(self, line):
        tokens = tokenize(line)
        if not tokens:
            return
        try:
            mode, node, args = self.parse(tokens)
        except ParseError as e:
            if e.pos is not None:
                # Ciscoと同じく、どこで間違えたかを^で示す
                offset = len(self.prompt()) + len(' '.join(tokens[: e.pos])) + (1 if e.pos else 0)
                print(' ' * offset + '^')
            print(e)
            return
        if node.func is None:
            print('% Incomplete command.')
            return
        self.mode = mode
        node.func(args)

    def run(self):
        import readline
        import termios
        readline.set_completer(self.complete)
        readline.set_completer_delims(' ')
        readline.parse_and_bind('tab: complete')
        readline.parse_and_bind('set show-all-if-ambiguous on')  # 候補が複数ならすぐ一覧を出す
        # ? は打った瞬間にヘルプを出す（Ciscoと同じ。入力中の行はそのまま残す）
        readline.parse_and_bind('"?": "\\C-v?\\n"')
        # Ctrl+Z：入力中の行を実行してから特権モードに戻る（Ciscoと同じ）。端末のサスペンド（SIGTSTP）を
        # 止めてreadlineに届くようにし、行末に「^Z」を付けて確定させる
        readline.parse_and_bind('"\\C-z": "\\C-e ^Z\\n"')
        saved_tty = None
        try:
            fd = sys.stdin.fileno()
            saved_tty = termios.tcgetattr(fd)
            attrs = termios.tcgetattr(fd)
            attrs[6][termios.VSUSP] = 0
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
        except (termios.error, OSError, ValueError):
            saved_tty = None
        signal.signal(signal.SIGTSTP, signal.SIG_IGN)
        print('\nFree-Networking-labs L2 switch  (type ? for help, Tab to complete)\n')
        pending = ''
        try:
            while True:
                try:
                    line = self.input_with(pending)
                except KeyboardInterrupt:
                    # Ctrl+C：入力を捨てる。設定モードなら特権モードに戻る（Ciscoと同じ）
                    print()
                    self.mode = 'exec'
                    pending = ''
                    continue
                except EOFError:
                    print()
                    if self.mode == 'exec':
                        return
                    self.mode = 'exec'
                    pending = ''
                    continue
                pending = ''
                ctrl_z = line.endswith('^Z')
                if ctrl_z:
                    line = line[:-2]
                if line.endswith('?') and not ctrl_z:
                    pending = line[:-1]
                    self.help(pending)
                    continue
                try:
                    self.execute(line)
                except EOFError:
                    return
                except Exception as e:
                    print(f'% Error: {e}')
                if ctrl_z:
                    self.mode = 'exec'
        finally:
            if saved_tty is not None:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved_tty)

    def input_with(self, text):
        import readline
        readline.set_startup_hook(lambda: readline.insert_text(text))
        try:
            return input(self.prompt())
        finally:
            readline.set_startup_hook()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--agent':
        agent()
    else:
        Cli().run()


if __name__ == '__main__':
    main()
