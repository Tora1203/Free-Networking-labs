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
# コマンドの文法（Cisco風：各キーワードは一意に決まる範囲で省略できる）
# ---------------------------------------------------------------------------
# 要素：キーワード（文字列）か、引数を表す <...>。
#   <vlan>  1〜4094     <vlans> VLANリスト(1,10-20)    <iface> eth1（e1/et1も可）
#   <ifaces> eth1-3,eth5   <word> 1語   <line> 行の残り全部

def norm_iface(tok):
    m = re.fullmatch(r'e(?:t(?:h(?:ernet)?)?)?(\d+)', tok, re.I)
    return f'eth{int(m.group(1))}' if m and int(m.group(1)) >= 1 else None


def norm_iface_range(tok):
    names = []
    for part in tok.split(','):
        m = re.fullmatch(r'(e(?:t(?:h(?:ernet)?)?)?)?(\d+)(?:-(\d+))?', part, re.I)
        if not m:
            return None
        a, b = int(m.group(2)), int(m.group(3) or m.group(2))
        if not (1 <= a <= b <= 64):
            return None
        names += [f'eth{i}' for i in range(a, b + 1)]
    return names or None


ARG_CHECK = {
    '<vlan>': lambda t: t.isdigit() and 1 <= int(t) <= 4094,
    '<vlans>': lambda t: parse_vlan_list(t) is not None,
    '<iface>': lambda t: norm_iface(t) is not None,
    '<ifaces>': lambda t: norm_iface_range(t) is not None,
    '<word>': lambda t: True,
    '<line>': lambda t: True,
}
KEYWORD_HELP = {
    'configure': '設定モードに入る', 'terminal': '端末から設定する', 'copy': '設定をコピーする',
    'show': '状態や設定を表示する', 'write': '設定を保存する', 'memory': 'startup-configに保存',
    'interfaces': 'インターフェースの情報', 'mac': 'MACアドレステーブル', 'address-table': 'MACアドレステーブル',
    'vlan': 'VLAN', 'interface': 'インターフェースの設定', 'range': '複数のインターフェース',
    'switchport': 'スイッチポートの設定', 'mode': 'ポートのモード', 'access': 'アクセスポート',
    'trunk': 'トランクポート', 'allowed': '許可するVLAN', 'native': 'ネイティブVLAN（タグなし）',
    'no': '設定を消す・既定に戻す', 'do': '特権モードのコマンドを実行', 'hostname': 'ホスト名',
    'name': 'VLANの名前', 'description': '説明', 'shutdown': 'ポートを無効にする',
    'end': '特権モードに戻る', 'exit': '1つ上のモードに戻る', 'running-config': '現在の設定',
    'startup-config': '保存済みの設定', 'status': 'ポートの状態', 'brief': '一覧', 'add': '追加',
    'remove': '削除', 'all': 'すべて', 'none': 'なし',
}
ARG_HELP = {
    '<vlan>': '<1-4094>  VLAN ID', '<vlans>': 'WORD  VLANリスト（例 10,20,30-40）',
    '<iface>': 'ethN  インターフェース（例 eth1）', '<ifaces>': 'WORD  範囲（例 eth1-3,eth5）',
    '<word>': 'WORD', '<line>': 'LINE',
}


class Cli:
    def __init__(self):
        self.mode = 'exec'
        self.ifaces = []  # interfaceモードの対象
        self.vlan = None  # vlanモードの対象
        self.grammar = self.build_grammar()

    # ---- 文法 ----
    def build_grammar(self):
        show = [
            (['show', 'running-config'], lambda a: print(show_running(self.cfg())), '現在の設定'),
            (['show', 'startup-config'], self.show_startup, '保存済みの設定'),
            (['show', 'vlan', 'brief'], lambda a: print(show_vlan_brief(self.cfg())), 'VLANとアクセスポートの一覧'),
            (['show', 'vlan'], lambda a: print(show_vlan_brief(self.cfg())), 'VLANとアクセスポートの一覧'),
            (['show', 'interfaces', 'status'], lambda a: print(show_interfaces_status(self.cfg())), 'ポートの状態'),
            (['show', 'interfaces', 'trunk'], lambda a: print(show_interfaces_trunk(self.cfg())), 'トランクポート'),
            (['show', 'mac', 'address-table'], lambda a: print(show_mac(self.cfg())), '学習したMACアドレス'),
        ]
        common_cfg = [
            (['end'], self.do_end, '特権モードに戻る'),
            (['exit'], self.do_exit, '1つ上のモードに戻る'),
            (['do', '<line>'], self.do_do, '特権モードのコマンドを実行'),
        ]
        return {
            'exec': show + [
                (['configure', 'terminal'], self.do_conf, '設定モードに入る'),
                (['write', 'memory'], self.do_write, '設定を保存する'),
                (['write'], self.do_write, '設定を保存する'),
                (['copy', 'running-config', 'startup-config'], self.do_write, '設定を保存する'),
                (['exit'], self.do_logout, 'コンソールを抜ける'),
                (['quit'], self.do_logout, 'コンソールを抜ける'),
            ],
            'config': common_cfg + [
                (['hostname', '<word>'], self.do_hostname, 'ホスト名'),
                (['interface', 'range', '<ifaces>'], self.do_interface_range, '複数のインターフェースをまとめて設定'),
                (['interface', '<iface>'], self.do_interface, 'インターフェースの設定'),
                (['vlan', '<vlans>'], self.do_vlan, 'VLANを作る'),
                (['no', 'vlan', '<vlans>'], self.do_no_vlan, 'VLANを消す'),
            ],
            'vlan': common_cfg + [
                (['name', '<word>'], self.do_vlan_name, 'VLANの名前'),
                (['no', 'name'], self.do_vlan_no_name, 'VLANの名前を消す'),
            ],
            'interface': common_cfg + [
                (['switchport', 'mode', 'access'], lambda a: self.set_port(mode='access'), 'アクセスポートにする'),
                (['switchport', 'mode', 'trunk'], lambda a: self.set_port(mode='trunk'), 'トランクポートにする'),
                (['switchport', 'access', 'vlan', '<vlan>'], self.do_access_vlan, 'アクセスVLAN'),
                (['no', 'switchport', 'access', 'vlan'], lambda a: self.set_port(access_vlan=None), 'アクセスVLANを1に戻す'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'all'], lambda a: self.set_port(allowed=None), '全VLANを許可'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'add', '<vlans>'], self.do_allowed_add, '許可VLANを追加'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'remove', '<vlans>'], self.do_allowed_remove, '許可VLANを削除'),
                (['switchport', 'trunk', 'allowed', 'vlan', 'none'], lambda a: self.set_port(allowed=[]), 'どのVLANも許可しない'),
                (['switchport', 'trunk', 'allowed', 'vlan', '<vlans>'], self.do_allowed, '許可VLANを指定'),
                (['no', 'switchport', 'trunk', 'allowed', 'vlan'], lambda a: self.set_port(allowed=None), '全VLAN許可に戻す'),
                (['switchport', 'trunk', 'native', 'vlan', '<vlan>'], self.do_native, 'ネイティブVLAN（タグなし）'),
                (['no', 'switchport', 'trunk', 'native', 'vlan'], lambda a: self.set_port(native=None), 'ネイティブVLANを1に戻す'),
                (['shutdown'], lambda a: self.set_port(shutdown=True), 'ポートを無効にする'),
                (['no', 'shutdown'], lambda a: self.set_port(shutdown=None), 'ポートを有効にする'),
                (['description', '<line>'], self.do_description, '説明'),
                (['no', 'description'], lambda a: self.set_port(description=None), '説明を消す'),
            ],
        }

    @staticmethod
    def elem_matches(elem, tok):
        if elem.startswith('<'):
            return ARG_CHECK[elem](tok)
        return elem.startswith(tok.lower())

    def candidates(self, tokens):
        """tokensに前方一致する文法の一覧（引数の値も返す）"""
        result = []
        for pattern, func, help_ in self.grammar[self.mode]:
            args = []
            ok = True
            for i, tok in enumerate(tokens):
                if i >= len(pattern):
                    ok = False
                    break
                elem = pattern[i]
                if elem == '<line>':
                    args.append(' '.join(tokens[i:]))
                    break
                if not self.elem_matches(elem, tok):
                    ok = False
                    break
                if elem.startswith('<'):
                    args.append(tok)
            if ok:
                result.append((pattern, func, help_, args))
        return result

    def resolve(self, tokens):
        cands = self.candidates(tokens)
        full = [c for c in cands if len(c[0]) == len(tokens) or (c[0][-1] == '<line>' and len(tokens) >= len(c[0]))]
        if not cands:
            return None, '% Invalid input detected'
        if not full:
            return None, '% Incomplete command.'
        # 引数よりキーワードの完全一致を優先し、それでも複数なら最初に完全一致したもの
        def score(c):
            return sum(1 for e, t in zip(c[0], tokens) if not e.startswith('<') and e == t.lower())
        best = max(full, key=score)
        # 同じ位置で違うキーワードに前方一致する（例 "s" → show/switchport）なら曖昧
        for i, tok in enumerate(tokens):
            kws = {c[0][i] for c in full if i < len(c[0]) and not c[0][i].startswith('<')}
            if len(kws) > 1 and tok.lower() not in kws:
                return None, f'% Ambiguous command:  "{" ".join(tokens)}"'
        return best, None

    def help(self, line):
        """「?」：次に入力できるもの（途中まで打った語なら、それに一致するもの）を一覧する"""
        tokens = line.split()
        partial = bool(tokens) and not line.endswith(' ')
        prefix_tokens = tokens[:-1] if partial else tokens
        idx = len(prefix_tokens)
        seen = {}
        for pattern, _func, help_, _args in self.candidates(prefix_tokens):
            if idx < len(pattern):
                elem = pattern[idx]
                if partial and not self.elem_matches(elem, tokens[-1]):
                    continue
                if elem.startswith('<'):
                    label, _, desc = ARG_HELP[elem].partition('  ')
                else:
                    label, desc = elem, (help_ if idx == len(pattern) - 1 else KEYWORD_HELP.get(elem, ''))
                seen.setdefault(label, desc)
            elif idx == len(pattern) and not partial:
                seen.setdefault('<cr>', '')
        if not seen:
            print('% Unrecognized command')
        for label, desc in sorted(seen.items()):
            print(f'  {label:<20}{desc}')

    def complete(self, text, state):
        import readline
        line = readline.get_line_buffer()[: readline.get_endidx()]
        tokens = line.split()
        prefix_tokens = tokens if line.endswith(' ') or not tokens else tokens[:-1]
        idx = len(prefix_tokens)
        opts = sorted({
            p[idx] for p, *_ in self.candidates(prefix_tokens)
            if idx < len(p) and not p[idx].startswith('<') and p[idx].startswith(text.lower())
        })
        return (opts[state] + ' ') if state < len(opts) else None

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
        tokens = line.split()
        if not tokens:
            return
        cand, err = self.resolve(tokens)
        if err and self.mode in ('interface', 'vlan'):
            # Ciscoと同じく、interface/vlanモードのままでも設定モードのコマンド（別のinterfaceへの
            # 切り替え等）を打てる。その場合は設定モードに戻ってから実行する
            saved = self.mode
            self.mode = 'config'
            cand, config_err = self.resolve(tokens)
            if config_err:
                self.mode = saved
            else:
                err = None
        if err:
            print(err)
            return
        pattern, func, _, args = cand
        func(args)

    def run(self):
        import readline
        readline.set_completer(self.complete)
        readline.set_completer_delims(' ')
        readline.parse_and_bind('tab: complete')
        readline.parse_and_bind('"?": "\\C-v?\\n"')  # ?で即座にヘルプ（行は消さずに残す、下で再入力）
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTSTP, signal.SIG_IGN)
        print('\nFree-Networking-labs L2 switch CLI（? でヘルプ、Tabで補完）\n')
        pending = ''
        while True:
            try:
                line = self.input_with(pending)
            except EOFError:
                if self.mode == 'exec':
                    print()
                    return
                print()
                self.mode = 'exec'
                pending = ''
                continue
            pending = ''
            if line.endswith('?'):
                body = line[:-1]
                self.help(body)
                pending = body
                continue
            try:
                self.execute(line)
            except EOFError:
                return
            except Exception as e:
                print(f'% Error: {e}')

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
