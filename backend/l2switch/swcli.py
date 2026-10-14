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

STP（2026-10-14）：mstpd（RSTP/MSTPのデーモン、mstpd/fnl.patchでコンテナ向けに改修）で
STP（802.1D）/ RSTP（802.1w）/ MSTP（802.1s）を動かす。モードは spanning-tree mode stp | rapid-stp | mstp
（Ciscoのpvst/rapid-pvstは独自方式でLinuxでは動かないため、名前も標準規格に合わせた）。
既定は rapid-stp で有効（最近の機種はRSTP系が既定：Juniper EXはRSTP、AristaはMSTP、Nexusはrapid-pvst）。
コンテナではカーネルのユーザーSTPモードが使えないため、カーネルのSTPは切り（stp_state 0）、
mstpdが決めたポート状態をカーネルのMST（mst_enabled）のポート状態として設定する。
カーネルのMSTI 0は設定できないので、CISTはカーネルのMSTI 4094に対応させる（利用者のMSTIは1-4093）。
BPDUは各ポートの入口（tc）で捨ててブリッジに転送させず、mstpdはその手前でタップして受け取る。
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
        'stp_cost': p.get('stp_cost'),  # None＝既定（stp/rapid-stpは短いコスト、mstpは長いコスト）
        'stp_port_priority': p.get('stp_port_priority', 128),
        'portfast': p.get('portfast'),  # None＝portfast defaultに従う、True/False＝明示
        'bpduguard': p.get('bpduguard'),  # None＝portfast bpduguard defaultに従う、True/False＝明示
        'bpdufilter': p.get('bpdufilter', False),
        'guard_root': p.get('guard_root', False),
    }


STP_MODES = ('stp', 'rapid-stp', 'mstp')
STP_DEFAULTS = {'enabled': True, 'mode': 'rapid-stp', 'priority': 32768, 'hello': 2, 'forward': 15, 'max_age': 20,
                'portfast_default': False, 'bpduguard_default': False}
CIST_KMSTI = 4094  # CISTを対応させるカーネルのMSTI（mstpd/fnl.patchと揃える）
MAX_MSTI = 4093


def stp_view(cfg):
    """既定値を埋めたSTP設定"""
    return {**STP_DEFAULTS, **cfg.get('stp', {})}


def mst_view(cfg):
    """MSTの設定。instances：{'1': [10, 20]}、priority：{'1': 4096}"""
    m = cfg.get('mst', {})
    return {'name': m.get('name', ''), 'revision': m.get('revision', 0),
            'instances': m.get('instances', {}), 'priority': m.get('priority', {})}


def oper_edge(st, p):
    """portfast（エッジポート）として扱うか"""
    if p['portfast'] is not None:
        return p['portfast']
    return st['portfast_default'] and p['mode'] == 'access'


def oper_bpduguard(st, p):
    if p['bpduguard'] is not None:
        return p['bpduguard']
    return st['bpduguard_default'] and oper_edge(st, p)


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


def read_sys(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def port_speed(name):
    try:
        return int(read_sys(f'/sys/class/net/{name}/speed', '10000'))
    except ValueError:
        return 10000


def short_path_cost(speed):
    """Ciscoのstp/rapid-stp（pathcost method short）の既定コスト：10G=2, 1G=4, 100M=19, 10M=100"""
    for limit, cost in ((10000, 2), (1000, 4), (100, 19)):
        if speed >= limit:
            return cost
    return 100


def mstpctl(*args, as_json=False):
    r = sh('mstpctl', *(['-f', 'json'] if as_json else []), *args)
    if not as_json:
        return r
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except ValueError:
        return None


def vlan_to_msti(cfg):
    """VLAN→MSTI（mstpモードの時だけ。それ以外は全部CIST＝0）"""
    if stp_view(cfg)['mode'] != 'mstp':
        return {}
    return {v: int(i) for i, vlans in mst_view(cfg)['instances'].items() for v in vlans}


STATE_TO_KERNEL = {'forwarding': 3, 'learning': 2, 'listening': 1, 'discarding': 4, 'blocking': 4, 'disabled': 0}
ERRDISABLED = f'{RUN_DIR}/errdisabled.json'


def load_errdisabled():
    try:
        with open(ERRDISABLED) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def save_errdisabled(names):
    save(ERRDISABLED, sorted(names))


class StpAgent:
    """running-configのSTP設定をmstpdとカーネルに反映する（swcli --agentから毎秒呼ぶ）"""

    def __init__(self):
        self.bridge_key = None  # 最後にmstpdへ入れたブリッジ全体の設定
        self.port_keys = {}  # ポートごとの同上
        self.disabled_applied = False
        self.last_sync = 0.0
        self.msti_key = None  # 最後にVLAN→MSTIを確かめた時の設定
        self.last_msti_check = 0.0

    def tick(self, cfg, ports, changed):
        st = stp_view(cfg)
        # VLAN→MSTIの確認は重い（全VLAN許可のトランクだと4094個）ので、VLANや設定が変わった時と10秒ごとだけ
        msti_key = json.dumps(vlan_to_msti(cfg), sort_keys=True)
        if changed or msti_key != self.msti_key or time.time() - self.last_msti_check > 10:
            changed = self.sync_vlan_msti(cfg) or changed
            self.msti_key, self.last_msti_check = msti_key, time.time()
        # mstpdは監視しているだけのブリッジにもshowbridgeで答えるので、登録済み（stp-enabled）かで見る
        info = mstpctl('showbridge', BRIDGE, as_json=True)
        present = bool(info) and info[0].get('stp-enabled') == 'yes'
        if not st['enabled']:
            if present:
                mstpctl('delbridge', BRIDGE)
            if not self.disabled_applied or changed:
                # STPなし：全ポート・全ツリーを転送にする（ループを組むとストームになる。Ciscoのno spanning-treeと同じ）
                self.set_kernel_states({(n, k): 3 for n in ports for k in self.kernel_mstis(cfg)})
                self.disabled_applied = True
            self.bridge_key, self.port_keys = None, {}
            return
        self.disabled_applied = False
        if not present:
            mstpctl('addbridge', BRIDGE)
            self.bridge_key, self.port_keys = None, {}
        key = json.dumps([st, mst_view(cfg)], sort_keys=True)
        if key != self.bridge_key:
            self.apply_bridge(cfg, st)
            self.bridge_key = key
            changed = True
        for name in ports:
            p = port_view(cfg, name)
            pkey = json.dumps([p, st['mode'], oper_edge(st, p), oper_bpduguard(st, p), port_speed(name)], sort_keys=True)
            if self.port_keys.get(name) != pkey and self.apply_port(name, p, st):
                self.port_keys[name] = pkey
                changed = True
        if changed or time.time() - self.last_sync > 5:
            self.sync_states(cfg, ports)
            self.last_sync = time.time()

    def kernel_mstis(self, cfg):
        return {CIST_KMSTI} | set(vlan_to_msti(cfg).values())

    def sync_vlan_msti(self, cfg):
        """ブリッジにあるVLANを、設定どおりのカーネルのMSTIに割り当てる。変えたらTrue。
        MSTI 0のままのVLANはポートの状態（STP無効なので常に転送）で流れてループになるので、必ずどこかに割り当てる"""
        want = vlan_to_msti(cfg)
        r = sh('bridge', '-j', 'vlan', 'global', 'show', 'dev', BRIDGE)
        try:
            entries = json.loads(r.stdout or '[]')
        except ValueError:
            return False
        wrong = []  # (vid, 割り当てるべきMSTI)
        for entry in entries:
            # 同じ設定のVLANは vlan〜vlanEnd の範囲にまとめて返ってくる
            for v in entry.get('vlans', []):
                for vid in range(v['vlan'], v.get('vlanEnd', v['vlan']) + 1):
                    kmsti = want.get(vid, CIST_KMSTI)
                    if v.get('msti') != kmsti:
                        wrong.append((vid, kmsti))
        # 連続していて同じMSTIのものは範囲でまとめて設定する（全VLAN許可のトランクだと4094個あるため）
        start = None
        for idx, (vid, kmsti) in enumerate(wrong):
            if start is None:
                start = (vid, kmsti)
            nxt = wrong[idx + 1] if idx + 1 < len(wrong) else None
            if nxt is None or nxt != (vid + 1, kmsti):
                rng = str(start[0]) if start[0] == vid else f'{start[0]}-{vid}'
                sh('bridge', 'vlan', 'global', 'set', 'vid', rng, 'dev', BRIDGE, 'msti', str(kmsti))
                start = None
        return bool(wrong)

    def apply_bridge(self, cfg, st):
        mstpctl('setforcevers', BRIDGE, {'stp': 'stp', 'rapid-stp': 'rstp', 'mstp': 'mstp'}[st['mode']])
        # タイマーには相互の制約（max-age <= 2*(forward-1) 等）があるので、順番を変えて2回入れる
        for _ in range(2):
            mstpctl('setfdelay', BRIDGE, str(st['forward']))
            mstpctl('setmaxage', BRIDGE, str(st['max_age']))
            mstpctl('sethello', BRIDGE, str(st['hello']))
        mstpctl('settreeprio', BRIDGE, '0', str(st['priority'] // 4096))
        mst = mst_view(cfg)
        want = {int(i) for i in mst['instances']} if st['mode'] == 'mstp' else set()
        have = {int(i) for i in ((mstpctl('showmstilist', BRIDGE, as_json=True) or {}).get('mstids') or [])} - {0}
        for i in have - want:
            mstpctl('deletetree', BRIDGE, str(i))
        for i in want - have:
            mstpctl('createtree', BRIDGE, str(i))
        # 同じリージョンにするため、名前の既定は全スイッチ共通の値にする（mstpdの既定はMACアドレスでスイッチごとに違う）
        mstpctl('setmstconfid', BRIDGE, str(mst['revision']), mst['name'] or 'default')
        mapped = vlan_to_msti(cfg)
        fids = [f'0:{format_vlan_list([v for v in ALL_VLANS if v not in mapped])}']
        fids += [f'{i}:{format_vlan_list(sorted(v for v, m in mapped.items() if m == i))}' for i in sorted(want)]
        mstpctl('setvid2fid', BRIDGE, *fids)
        mstpctl('setfid2mstid', BRIDGE, '0:0', *[f'{i}:{i}' for i in sorted(want)])
        for i in sorted(want):
            mstpctl('settreeprio', BRIDGE, str(i), str(int(mst['priority'].get(str(i), 32768)) // 4096))

    def apply_port(self, name, p, st):
        """mstpdにまだポートが無い（ブリッジに入れた直後）と失敗するので、その時はFalseで次回やり直す"""
        cost = p['stp_cost'] or (0 if st['mode'] == 'mstp' else short_path_cost(port_speed(name)))  # 0＝mstpdの自動（長いコスト）
        yes = lambda b: 'yes' if b else 'no'  # noqa: E731
        results = [
            mstpctl('setportpathcost', BRIDGE, name, str(cost)),
            mstpctl('settreeportprio', BRIDGE, name, '0', str(p['stp_port_priority'] // 16)),
            # Ciscoと同じく、portfastでないポートは自動でエッジにしない
            mstpctl('setportautoedge', BRIDGE, name, 'no'),
            mstpctl('setportadminedge', BRIDGE, name, yes(oper_edge(st, p))),
            mstpctl('setbpduguard', BRIDGE, name, yes(oper_bpduguard(st, p))),
            mstpctl('setportbpdufilter', BRIDGE, name, yes(p['bpdufilter'])),
            mstpctl('setportrestrrole', BRIDGE, name, yes(p['guard_root'])),
        ]
        return all(r.returncode == 0 for r in results)

    def sync_states(self, cfg, ports):
        """mstpdのポート状態をカーネルに合わせ直す（VLANを足した直後などにずれるため）"""
        want = {}
        for d in mstpctl('showportdetail', BRIDGE, as_json=True) or []:
            want[(d['port'], CIST_KMSTI)] = STATE_TO_KERNEL.get(d.get('state'), 4)
        for i in sorted(set(vlan_to_msti(cfg).values())):
            for name in ports:
                d = mstpctl('showtreeport', BRIDGE, name, str(i), as_json=True)
                if d:
                    want[(name, i)] = STATE_TO_KERNEL.get(d.get('state'), 4)
        self.set_kernel_states(want)

    def set_kernel_states(self, want):
        current = {}
        try:
            for entry in json.loads(sh('bridge', '-j', 'mst', 'show').stdout or '[]'):
                for m in entry.get('mst', []):
                    current[(entry['ifname'], m['msti'])] = m['state']
        except ValueError:
            pass
        names = {v: k for k, v in STATE_TO_KERNEL.items() if k not in ('discarding',)}
        for (name, kmsti), state in want.items():
            if current.get((name, kmsti)) != names.get(state):
                sh('bridge', 'mst', 'set', 'dev', name, 'msti', str(kmsti), 'state', str(state))


def bpdu_guard_error(name):
    d = mstpctl('showportdetail', BRIDGE, name, as_json=True)
    return bool(d) and d[0].get('bpdu-guard-error') == 'yes'


def prepare_port(name):
    """ブリッジに入れる前に、入口でBPDUを捨てるフィルタを付ける（mstpdはその手前のタップで受け取る）"""
    sh('tc', 'qdisc', 'add', 'dev', name, 'clsact')
    sh('tc', 'filter', 'add', 'dev', name, 'ingress', 'protocol', 'all', 'pref', '1',
       'flower', 'dst_mac', '01:80:c2:00:00:00', 'action', 'drop')


def agent():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    os.makedirs(RUN_DIR, exist_ok=True)
    if not os.path.exists(RUNNING):
        save(RUNNING, load(STARTUP) if os.path.exists(STARTUP) else default_config())
    stp = StpAgent()
    # err-disabledからshutdownで戻したポート。mstpdのBPDU Guardのエラーはポートが上がるまで残るので、
    # 次にno shutdownで上げる時はそれを見ずに上げる（上がるとmstpdがエラーを消す）
    recovering = set()
    # ポートのVLANの確認（bridge vlan show）は全VLAN許可のトランクがあると重いので、設定が変わった時・
    # ポートが増えた時と10秒ごとだけ行う（毎秒やるとスイッチ1台でCPUを数%使っていた）
    last_vlan_check, last_mtime, last_ports = 0.0, None, None
    while True:
        try:
            if not os.path.exists(f'/sys/class/net/{BRIDGE}'):
                # カーネルのSTPは使わず（stp_state 0）、mstpdの決めた状態をMSTのポート状態として入れる
                sh('ip', 'link', 'add', BRIDGE, 'type', 'bridge', 'stp_state', '0', 'vlan_filtering', '1', 'mst_enabled', '1')
            sh('ip', 'link', 'set', BRIDGE, 'up')
            cfg = load(RUNNING)
            mtime = os.path.getmtime(RUNNING) if os.path.exists(RUNNING) else None
            ports = system_ports()
            check_vlans = mtime != last_mtime or ports != last_ports or time.time() - last_vlan_check > 10
            if check_vlans:
                current = current_vlans()
                last_vlan_check, last_mtime, last_ports = time.time(), mtime, ports
            errdisabled = load_errdisabled()
            errdisabled_before = set(errdisabled)
            changed = False
            for name in system_ports():
                p = port_view(cfg, name)
                if not os.path.exists(f'/sys/class/net/{name}/master'):
                    prepare_port(name)
                    sh('ip', 'link', 'set', name, 'master', BRIDGE)
                    if check_vlans:
                        current[name] = set()
                is_up = int(read_sys(f'/sys/class/net/{name}/flags', '0x0'), 16) & 1
                if p['shutdown']:
                    if name in errdisabled:  # Ciscoと同じく shutdown → no shutdown でerr-disabledから戻す
                        errdisabled.discard(name)
                        recovering.add(name)
                    if is_up:
                        sh('ip', 'link', 'set', name, 'down')
                elif not is_up and name not in errdisabled:
                    # BPDU Guardで止められたポート（mstpdがdownにする）は、err-disabledとして落としたままにする
                    if name not in recovering and bpdu_guard_error(name):
                        errdisabled.add(name)
                    else:
                        sh('ip', 'link', 'set', name, 'up')
                        recovering.discard(name)
                if check_vlans and current.get(name, set()) != desired_vlans(p):
                    apply_port(name, p)
                    changed = True
            if errdisabled != errdisabled_before:
                save_errdisabled(errdisabled)
            stp.tick(cfg, system_ports(), changed)
        except Exception as e:  # 1回の失敗で止まらないように
            print(f'agent: {e}', file=sys.stderr)
        time.sleep(1)


# ---------------------------------------------------------------------------
# show系
# ---------------------------------------------------------------------------

def link_status(name, p):
    if p['shutdown']:
        return 'disabled'
    if name in load_errdisabled():
        return 'err-disabled'
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
    lines += running_stp_lines(cfg)
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
        if p['portfast'] is not None:
            lines.append(' spanning-tree portfast' + ('' if p['portfast'] else ' disable'))
        if p['bpduguard'] is not None:
            lines.append(' spanning-tree bpduguard ' + ('enable' if p['bpduguard'] else 'disable'))
        if p['bpdufilter']:
            lines.append(' spanning-tree bpdufilter enable')
        if p['guard_root']:
            lines.append(' spanning-tree guard root')
        if p['stp_cost'] is not None:
            lines.append(f' spanning-tree cost {p["stp_cost"]}')
        if p['stp_port_priority'] != 128:
            lines.append(f' spanning-tree port-priority {p["stp_port_priority"]}')
        if p['shutdown']:
            lines.append(' shutdown')
        lines.append('!')
    lines.append('end')
    return '\n'.join(lines)


def running_stp_lines(cfg):
    st = stp_view(cfg)
    mst = mst_view(cfg)
    mstp = st['mode'] == 'mstp'
    lines = []
    if st['mode'] != STP_DEFAULTS['mode']:
        lines.append(f'spanning-tree mode {st["mode"]}')
    if st['portfast_default']:
        lines.append('spanning-tree portfast default')
    if st['bpduguard_default']:
        lines.append('spanning-tree portfast bpduguard default')
    if not st['enabled']:
        lines.append('no spanning-tree vlan 1-4094')
    # stp/rapid-stpはCiscoのPVSTと同じ書き方、mstpはMSTの書き方で出す（中身は同じCISTの設定）
    prefix = 'spanning-tree mst' if mstp else 'spanning-tree vlan 1-4094'
    if st['priority'] != STP_DEFAULTS['priority']:
        lines.append(f'{"spanning-tree mst 0" if mstp else prefix} priority {st["priority"]}')
    for key, word in (('hello', 'hello-time'), ('forward', 'forward-time'), ('max_age', 'max-age')):
        if st[key] != STP_DEFAULTS[key]:
            lines.append(f'{prefix} {word} {st[key]}')
    if mst['name'] or mst['revision'] or mst['instances']:
        lines.append('spanning-tree mst configuration')
        if mst['name']:
            lines.append(f' name {mst["name"]}')
        if mst['revision']:
            lines.append(f' revision {mst["revision"]}')
        for i in sorted(mst['instances'], key=int):
            lines.append(f' instance {i} vlan {format_vlan_list(mst["instances"][i])}')
    for i in sorted(mst['priority'], key=int):
        lines.append(f'spanning-tree mst {i} priority {mst["priority"][i]}')
    if lines:
        lines.append('!')
    return lines


def cisco_bridge_id(text):
    """mstpdの「8.000.AA:C1:AB:16:07:FA」→（優先度, 'aac1.ab16.07fa'）。先頭は優先度/4096、次がsys-id-ext"""
    try:
        prio, ext, mac = text.split('.', 2)
        mac = mac.replace(':', '').lower()
        return int(prio, 16) * 4096 + int(ext, 16), '.'.join(mac[i:i + 4] for i in range(0, 12, 4))
    except ValueError:
        return 0, text


ROLE_SHORT = {'Root': 'Root', 'Designated': 'Desg', 'Alternate': 'Altn', 'Backup': 'Back', 'Master': 'Mstr'}
STATE_SHORT = {'forwarding': 'FWD', 'learning': 'LRN', 'discarding': 'BLK', 'listening': 'LIS', 'blocking': 'BLK'}
PROTOCOL = {'stp': 'ieee', 'rapid-stp': 'rstp', 'mstp': 'mstp'}


def port_rows(cfg, details):
    """Interface Role Sts Cost Prio.Nbr Type の行。detailsはポート名→mstpdの情報（CISTはshowportdetail）"""
    out = [f'{"Interface":<20}{"Role":<5}{"Sts":<4}{"Cost":<10}{"Prio.Nbr":<9}Type',
           '------------------- ---- --- --------- -------- --------------------------------']
    st = stp_view(cfg)
    for name in sorted(details, key=iface_key):
        d = details[name]
        role = ROLE_SHORT.get(d.get('role'))
        if not role:  # Disabled（リンクが落ちている）ポートはCiscoと同じく出さない
            continue
        prio, _, nbr = d.get('port-id', '8.000').partition('.')
        cost = d.get('internal-port-cost') if 'mstid' in d else d.get('external-port-cost')  # MSTIの行は内部コスト
        types = ['P2p']
        if d.get('oper-edge-port') == 'yes':
            types.append('Edge')
        if d.get('received-stp') == 'yes' and st['mode'] != 'stp':
            types.append('Peer(STP)')
        if d.get('restricted-role') == 'yes' and role == 'Altn':
            types.append('*ROOT_Inc')
        out.append(f'{name:<20}{role:<5}{STATE_SHORT.get(d.get("state"), "BLK"):<4}{str(cost):<10}'
                   f'{f"{int(prio, 16) * 16}.{int(nbr, 16)}":<9}{" ".join(types)}')
    return out


def show_spanning_tree(cfg, only_msti=None):
    st = stp_view(cfg)
    br = mstpctl('showbridge', BRIDGE, as_json=True)
    if not st['enabled'] or not br:
        return 'No spanning tree instance exists.'
    br = br[0]
    ports = {d['port']: d for d in (mstpctl('showportdetail', BRIDGE, as_json=True) or [])}
    timers = (f'Hello Time  {int(br["hello-time"]):>2} sec  Max Age {int(br["max-age"]):>2} sec  '
              f'Forward Delay {int(br["forward-delay"]):>2} sec')
    out = []
    if only_msti in (None, 0):
        rprio, rmac = cisco_bridge_id(br['designated-root'])
        bprio, bmac = cisco_bridge_id(br['bridge-id'])
        out += ['', 'MST0' if st['mode'] == 'mstp' else 'CST (all VLANs)',
                f'  Spanning tree enabled protocol {PROTOCOL[st["mode"]]}',
                f'  Root ID    Priority    {rprio}', f'             Address     {rmac}']
        if br['designated-root'] == br['bridge-id']:
            out.append('             This bridge is the root')
        else:
            root_port = (br.get('root-port') or '?').split()[0]  # 「eth1 (#1)」の形で返ってくる
            pid = ports.get(root_port, {}).get('port-id', '8.000').partition('.')[2]
            out += [f'             Cost        {br["path-cost"]}', f'             Port        {int(pid, 16)} ({root_port})']
        out += [f'             {timers}', '',
                f'  Bridge ID  Priority    {bprio}  (priority {bprio - bprio % 4096} sys-id-ext {bprio % 4096})',
                f'             Address     {bmac}',
                f'             Hello Time  {st["hello"]:>2} sec  Max Age {st["max_age"]:>2} sec  Forward Delay {st["forward"]:>2} sec',
                '']
        out += port_rows(cfg, ports)
    if st['mode'] == 'mstp':
        mst = mst_view(cfg)
        for i in sorted(mst['instances'], key=int):
            if only_msti not in (None, int(i)):
                continue
            tree = mstpctl('showtree', BRIDGE, i, as_json=True)
            if not tree:
                continue
            rprio, rmac = cisco_bridge_id(tree['regional-root'])
            bprio, bmac = cisco_bridge_id(tree['bridge-id'])
            out += ['', f'MST{i}', f'  Spanning tree enabled protocol mstp',
                    f'  Vlans mapped: {format_vlan_list(mst["instances"][i])}',
                    f'  Root ID    Priority    {rprio}', f'             Address     {rmac}']
            if tree['regional-root'] == tree['bridge-id']:
                out.append('             This bridge is the root')
            else:
                out.append(f'             Port        {(tree.get("root-port") or "?").split()[0]}')
            out += [f'  Bridge ID  Priority    {bprio}  (priority {bprio - bprio % 4096} sys-id-ext {bprio % 4096})',
                    f'             Address     {bmac}', '']
            tports = {}
            for name in ports:
                d = mstpctl('showtreeport', BRIDGE, name, i, as_json=True)
                if d:
                    d['oper-edge-port'] = ports[name].get('oper-edge-port')
                    tports[name] = d
            out += port_rows(cfg, tports)
    if only_msti is not None and not out:
        return f'% MST instance {only_msti} does not exist'
    return '\n'.join(out)


def show_mst_configuration(cfg):
    mst = mst_view(cfg)
    out = [f'Name      [{mst["name"]}]', f'Revision  {mst["revision"]}     Instances configured {len(mst["instances"]) + 1}', '',
           'Instance  Vlans mapped', '--------  ---------------------------------------------------------------------']
    mapped = {v for vlans in mst['instances'].values() for v in vlans}
    out.append(f'{0:<10}{format_vlan_list([v for v in ALL_VLANS if v not in mapped])}')
    for i in sorted(mst['instances'], key=int):
        out.append(f'{i:<10}{format_vlan_list(mst["instances"][i])}')
    out.append('-' * 79)
    if stp_view(cfg)['mode'] != 'mstp':
        out.append('% Note: spanning-tree mode is not mstp; this configuration is not in use.')
    return '\n'.join(out)


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
    '<bridge-prio>': lambda t: t.isdigit() and int(t) <= 61440 and int(t) % 4096 == 0,
    '<port-prio>': lambda t: t.isdigit() and int(t) <= 240 and int(t) % 16 == 0,
    '<cost>': lambda t: t.isdigit() and 1 <= int(t) <= 200000000,
    '<msti>': lambda t: t.isdigit() and 1 <= int(t) <= MAX_MSTI,
    '<msti0>': lambda t: t.isdigit() and 0 <= int(t) <= MAX_MSTI,
    '<revision>': lambda t: t.isdigit() and int(t) <= 65535,
    '<hello>': lambda t: t.isdigit() and 1 <= int(t) <= 10,
    '<fwd>': lambda t: t.isdigit() and 4 <= int(t) <= 30,
    '<maxage>': lambda t: t.isdigit() and 6 <= int(t) <= 40,
}
ARG_HELP = {
    '<vlan>': ('<1-4094>', 'VLAN ID'),
    '<vlans>': ('WORD', 'VLAN IDs of the allowed VLANs (e.g. 10,20,30-40)'),
    '<iface>': ('ethN', 'Interface (e.g. eth1)'),
    '<ifaces>': ('WORD', 'Interface range (e.g. eth1-3,eth5)'),
    '<word>': ('WORD', ''),
    '<line>': ('LINE', ''),
    '<bridge-prio>': ('<0-61440>', 'bridge priority in increments of 4096'),
    '<port-prio>': ('<0-240>', 'port priority in increments of 16'),
    '<cost>': ('<1-200000000>', 'port path cost'),
    '<msti>': (f'<1-{MAX_MSTI}>', 'MST instance id'),
    '<msti0>': (f'<0-{MAX_MSTI}>', 'MST instance id (0 = CIST)'),
    '<revision>': ('<0-65535>', 'Configuration revision number'),
    '<hello>': ('<1-10>', 'number of seconds between generation of config BPDUs'),
    '<fwd>': ('<4-30>', 'number of seconds for the forward delay timer'),
    '<maxage>': ('<6-40>', 'maximum number of seconds the information in a BPDU is valid'),
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
    'spanning-tree': 'Spanning Tree Subsystem', 'priority': 'Set the bridge priority for the spanning tree',
    'root': 'Configure switch as root', 'primary': 'Configure this switch as primary root for this spanning tree',
    'secondary': 'Configure switch as secondary root', 'hello-time': 'Set the hello interval for the spanning tree',
    'forward-time': 'Set the forward delay for the spanning tree', 'max-age': 'Set the max age interval for the spanning tree',
    'cost': 'Change an interface\'s spanning tree port path cost',
    'port-priority': 'Change an interface\'s spanning tree port priority',
    'portfast': 'Spanning tree portfast options', 'mst': 'Multiple spanning tree configuration',
    'configuration': 'Enter MST configuration submode', 'instance': 'Map vlans to an MST instance',
    'revision': 'Set configuration revision number', 'bpduguard': 'Don\'t accept BPDUs on this interface',
    'bpdufilter': 'Don\'t send or receive BPDUs on this interface', 'guard': 'Change an interface\'s spanning tree guard mode',
    'default': 'Enable by default on all access ports', 'stp': 'IEEE 802.1D spanning tree',
    'rapid-stp': 'IEEE 802.1w rapid spanning tree', 'mstp': 'IEEE 802.1s multiple spanning tree',
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
            (['show', 'spanning-tree'], p(show_spanning_tree), 'Spanning tree topology'),
            (['show', 'spanning-tree', 'mst'], lambda a: print(show_spanning_tree(self.cfg(), None)), 'Multiple spanning trees'),
            (['show', 'spanning-tree', 'mst', '<msti0>'], lambda a: print(show_spanning_tree(self.cfg(), int(a[0]))), 'MST instance'),
            (['show', 'spanning-tree', 'mst', 'configuration'], p(show_mst_configuration), 'MST current region configuration'),
        ]
        stp_vlan = ['spanning-tree', 'vlan', '<vlans>']
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
                (stp_vlan, lambda a: self.set_stp(a, enabled=None), 'Enable spanning tree'),
                (['no'] + stp_vlan, lambda a: self.set_stp(a, enabled=False), 'Disable spanning tree'),
                (stp_vlan + ['priority', '<bridge-prio>'], lambda a: self.set_stp(a, priority=int(a[1])), 'Set the bridge priority'),
                (stp_vlan + ['root', 'primary'], lambda a: self.set_stp(a, priority=24576), 'Configure this switch as primary root'),
                (stp_vlan + ['root', 'secondary'], lambda a: self.set_stp(a, priority=28672), 'Configure switch as secondary root'),
                (stp_vlan + ['hello-time', '<hello>'], lambda a: self.set_stp(a, hello=int(a[1])), 'Set the hello interval'),
                (stp_vlan + ['forward-time', '<fwd>'], lambda a: self.set_stp(a, forward=int(a[1])), 'Set the forward delay'),
                (stp_vlan + ['max-age', '<maxage>'], lambda a: self.set_stp(a, max_age=int(a[1])), 'Set the max age interval'),
                (['no'] + stp_vlan + ['priority'], lambda a: self.set_stp(a, priority=None), 'Reset the bridge priority'),
                (['no'] + stp_vlan + ['root'], lambda a: self.set_stp(a, priority=None), 'Reset the bridge priority'),
                (['no'] + stp_vlan + ['hello-time'], lambda a: self.set_stp(a, hello=None), 'Reset the hello interval'),
                (['no'] + stp_vlan + ['forward-time'], lambda a: self.set_stp(a, forward=None), 'Reset the forward delay'),
                (['no'] + stp_vlan + ['max-age'], lambda a: self.set_stp(a, max_age=None), 'Reset the max age interval'),
                (['spanning-tree', 'mode', 'stp'], lambda a: self.set_stp_global(mode='stp'), 'IEEE 802.1D spanning tree'),
                (['spanning-tree', 'mode', 'rapid-stp'], lambda a: self.set_stp_global(mode='rapid-stp'), 'IEEE 802.1w rapid spanning tree'),
                (['spanning-tree', 'mode', 'mstp'], lambda a: self.set_stp_global(mode='mstp'), 'IEEE 802.1s multiple spanning tree'),
                (['no', 'spanning-tree', 'mode'], lambda a: self.set_stp_global(mode=None), 'Reset the mode to rapid-stp'),
                (['spanning-tree', 'portfast', 'default'], lambda a: self.set_stp_global(portfast_default=True), 'Enable portfast by default on all access ports'),
                (['no', 'spanning-tree', 'portfast', 'default'], lambda a: self.set_stp_global(portfast_default=None), 'Disable portfast by default'),
                (['spanning-tree', 'portfast', 'bpduguard', 'default'], lambda a: self.set_stp_global(bpduguard_default=True),
                 'Enable bpdu guard by default on all portfast ports'),
                (['no', 'spanning-tree', 'portfast', 'bpduguard', 'default'], lambda a: self.set_stp_global(bpduguard_default=None),
                 'Disable bpdu guard by default'),
                (['spanning-tree', 'mst', 'configuration'], self.do_mst_configuration, 'Enter MST configuration submode'),
                (['spanning-tree', 'mst', '<msti0>', 'priority', '<bridge-prio>'], lambda a: self.set_mst_priority(a[0], int(a[1])), 'Set the bridge priority'),
                (['spanning-tree', 'mst', '<msti0>', 'root', 'primary'], lambda a: self.set_mst_priority(a[0], 24576), 'Configure as primary root'),
                (['spanning-tree', 'mst', '<msti0>', 'root', 'secondary'], lambda a: self.set_mst_priority(a[0], 28672), 'Configure as secondary root'),
                (['no', 'spanning-tree', 'mst', '<msti0>', 'priority'], lambda a: self.set_mst_priority(a[0], None), 'Reset the bridge priority'),
                (['no', 'spanning-tree', 'mst', '<msti0>', 'root'], lambda a: self.set_mst_priority(a[0], None), 'Reset the bridge priority'),
                (['spanning-tree', 'mst', 'hello-time', '<hello>'], lambda a: self.set_stp_global(hello=int(a[0])), 'Set the hello interval'),
                (['spanning-tree', 'mst', 'forward-time', '<fwd>'], lambda a: self.set_stp_global(forward=int(a[0])), 'Set the forward delay'),
                (['spanning-tree', 'mst', 'max-age', '<maxage>'], lambda a: self.set_stp_global(max_age=int(a[0])), 'Set the max age interval'),
            ],
            'mst': common_cfg + [
                (['name', '<word>'], lambda a: self.set_mst(name=a[0]), 'Set configuration name'),
                (['no', 'name'], lambda a: self.set_mst(name=None), 'Reset the configuration name'),
                (['revision', '<revision>'], lambda a: self.set_mst(revision=None if int(a[0]) == 0 else int(a[0])), 'Set configuration revision number'),
                (['no', 'revision'], lambda a: self.set_mst(revision=None), 'Reset the revision number'),
                (['instance', '<msti>', 'vlan', '<vlans>'], self.do_mst_instance, 'Map vlans to an MST instance'),
                (['no', 'instance', '<msti>'], self.do_no_mst_instance, 'Unmap all vlans from an MST instance'),
                (['no', 'instance', '<msti>', 'vlan', '<vlans>'], self.do_no_mst_instance, 'Unmap vlans from an MST instance'),
                (['show'], lambda a: print(show_mst_configuration(self.cfg())), 'Display MST configuration'),
                (['show', 'current'], lambda a: print(show_mst_configuration(self.cfg())), 'Display MST configuration currently used'),
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
                (['spanning-tree', 'cost', '<cost>'], lambda a: self.set_port(stp_cost=int(a[0])), 'Change the port path cost'),
                (['no', 'spanning-tree', 'cost'], lambda a: self.set_port(stp_cost=None), 'Reset the port path cost'),
                (['spanning-tree', 'port-priority', '<port-prio>'],
                 lambda a: self.set_port(stp_port_priority=None if int(a[0]) == 128 else int(a[0])), 'Change the port priority'),
                (['no', 'spanning-tree', 'port-priority'], lambda a: self.set_port(stp_port_priority=None), 'Reset the port priority'),
                (['spanning-tree', 'portfast'], lambda a: self.set_port(portfast=True), 'Enable an interface to move directly to forwarding on link up'),
                (['spanning-tree', 'portfast', 'disable'], lambda a: self.set_port(portfast=False), 'Disable portfast for this interface'),
                (['no', 'spanning-tree', 'portfast'], lambda a: self.set_port(portfast=None), 'Use the global portfast default'),
                (['spanning-tree', 'bpduguard', 'enable'], lambda a: self.set_port(bpduguard=True), 'Enable BPDU guard for this interface'),
                (['spanning-tree', 'bpduguard', 'disable'], lambda a: self.set_port(bpduguard=False), 'Disable BPDU guard for this interface'),
                (['no', 'spanning-tree', 'bpduguard'], lambda a: self.set_port(bpduguard=None), 'Use the global bpduguard default'),
                (['spanning-tree', 'bpdufilter', 'enable'], lambda a: self.set_port(bpdufilter=True), 'Enable BPDU filtering for this interface'),
                (['spanning-tree', 'bpdufilter', 'disable'], lambda a: self.set_port(bpdufilter=None), 'Disable BPDU filtering for this interface'),
                (['no', 'spanning-tree', 'bpdufilter'], lambda a: self.set_port(bpdufilter=None), 'Disable BPDU filtering for this interface'),
                (['spanning-tree', 'guard', 'root'], lambda a: self.set_port(guard_root=True), 'Set guard mode to root guard on interface'),
                (['spanning-tree', 'guard', 'none'], lambda a: self.set_port(guard_root=None), 'Set guard mode to none'),
                (['no', 'spanning-tree', 'guard'], lambda a: self.set_port(guard_root=None), 'Set guard mode to none'),
            ],
        }

    def parse(self, tokens):
        """今のモードで解釈する。interface/vlanモードで通らなければ、Ciscoと同じく設定モードの
        コマンド（別のinterfaceへの移動等）として解釈し直す。(モード, Node, 引数)"""
        try:
            node, args = walk(self.trees[self.mode], tokens)
            return self.mode, node, args
        except ParseError:
            if self.mode not in ('interface', 'vlan', 'mst'):
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
        self.mode = 'config' if self.mode in ('interface', 'vlan', 'mst') else 'exec'

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

    def set_stp(self, a, **changes):
        """spanning-tree vlan <list> ...。stp/rapid-stpは全VLANで1つのツリーなので、指定したVLANに関わらず全VLANに効く"""
        if parse_vlan_list(a[0]) != ALL_VLANS:
            print('% Note: stp/rapid-stp run a single spanning tree for all VLANs (PVST is not supported).')
            print('%       The setting is applied to all VLANs. Use "spanning-tree mode mstp" for per-VLAN trees.')
        self.set_stp_global(**changes)

    def set_stp_global(self, **changes):
        def fn(cfg):
            st = cfg.setdefault('stp', {})
            for k, v in changes.items():
                if v is None or v == STP_DEFAULTS[k]:
                    st.pop(k, None)
                else:
                    st[k] = v
            if not st:
                cfg.pop('stp')
        self.modify(fn)

    def set_mst(self, **changes):
        def fn(cfg):
            m = cfg.setdefault('mst', {})
            for k, v in changes.items():
                if v is None:
                    m.pop(k, None)
                else:
                    m[k] = v
            if not m:
                cfg.pop('mst')
        self.modify(fn)

    def set_mst_priority(self, msti, prio):
        if int(msti) == 0:  # MST0＝CIST。stp/rapid-stpのブリッジ優先度と同じ設定
            self.set_stp_global(priority=prio)
            return

        def fn(cfg):
            m = cfg.setdefault('mst', {})
            pr = m.setdefault('priority', {})
            if prio is None or prio == 32768:
                pr.pop(str(int(msti)), None)
            else:
                pr[str(int(msti))] = prio
            if not pr:
                m.pop('priority')
            if not m:
                cfg.pop('mst')
        self.modify(fn)

    def do_mst_configuration(self, a):
        self.mode = 'mst'

    def do_mst_instance(self, a):
        msti, vlans = str(int(a[0])), parse_vlan_list(a[1])

        def fn(cfg):
            inst = cfg.setdefault('mst', {}).setdefault('instances', {})
            for k in list(inst):  # 1つのVLANは1つのインスタンスにしか入らない（Ciscoと同じく前の割り当てから移す）
                inst[k] = [v for v in inst[k] if v not in vlans]
                if not inst[k]:
                    inst.pop(k)
            inst[msti] = sorted(set(inst.get(msti, [])) | set(vlans))
        self.modify(fn)

    def do_no_mst_instance(self, a):
        msti = str(int(a[0]))
        vlans = set(parse_vlan_list(a[1])) if len(a) > 1 else None

        def fn(cfg):
            m = cfg.setdefault('mst', {})
            inst = m.setdefault('instances', {})
            if msti in inst:
                inst[msti] = [] if vlans is None else [v for v in inst[msti] if v not in vlans]
                if not inst[msti]:
                    inst.pop(msti)
            if not inst:
                m.pop('instances')
            if not m:
                cfg.pop('mst')
        self.modify(fn)

    def do_description(self, a):
        self.set_port(description=a[0])

    # ---- 実行ループ ----
    def prompt(self):
        host = self.cfg()['hostname']
        return {'exec': f'{host}#', 'config': f'{host}(config)#', 'interface': f'{host}(config-if)#',
                'vlan': f'{host}(config-vlan)#', 'mst': f'{host}(config-mst)#'}[self.mode]

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
