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
import threading
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
        'psec': psec_view(p.get('psec')),
        'lldp_tx': p.get('lldp_tx', True),
        'lldp_rx': p.get('lldp_rx', True),
        'cdp': p.get('cdp', True),
    }


def psec_view(ps):
    ps = ps or {}
    return {'enabled': ps.get('enabled', False), 'max': ps.get('max', 1), 'violation': ps.get('violation', 'shutdown'),
            'sticky': ps.get('sticky', False), 'macs': ps.get('macs', [])}


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
    """並べ順：eth1, eth2, ... → po1, po2, ..."""
    m = re.match(r'(eth|po)(\d+)$', name)
    return (0 if m.group(1) == 'eth' else 1, int(m.group(2))) if m else (2, 0)


def system_ports():
    try:
        names = os.listdir('/sys/class/net')
    except OSError:
        return []
    return sorted((n for n in names if re.fullmatch(r'eth[1-9]\d*', n)), key=iface_key)


def all_ports(cfg):
    pos = {f'po{n}' for n in channel_groups(cfg)}
    return sorted(set(system_ports()) | set(cfg['interfaces']) | pos, key=iface_key)


# ---- EtherChannel（2026-10-14〜）。eth に channel-group N mode active|passive|on を入れると、
# Linuxのbond（poN）にまとめる（active/passive＝LACP（802.3ad）、on＝LACPなしの固定）。VLAN・STP等の設定は
# interface port-channel N（poN）に入れたものが効く（メンバーのethの設定は使わない。Ciscoと同じ）

def channel_groups(cfg):
    """{N: {'mode': 'active', 'members': ['eth1', 'eth2']}}"""
    groups = {}
    for name, p in cfg['interfaces'].items():
        cg = p.get('channel_group')
        if cg and name.startswith('eth'):
            g = groups.setdefault(int(cg['id']), {'mode': cg['mode'], 'members': []})
            g['members'].append(name)
    for g in groups.values():
        g['members'].sort(key=iface_key)
    return groups


def member_of(cfg, name):
    cg = cfg['interfaces'].get(name, {}).get('channel_group')
    return int(cg['id']) if cg else None


def bridge_ports(cfg):
    """ブリッジに入るポート（channel-groupに入っていないeth＋port-channel）。VLAN・STPの対象"""
    members = {m for g in channel_groups(cfg).values() for m in g['members']}
    pos = [f'po{n}' for n in channel_groups(cfg)]
    return sorted([n for n in system_ports() if n not in members] + pos, key=iface_key)


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


_speed_cache = {}


def port_speed(name):
    """ポートの速度（Mbps）。GUIのリンクの品質（netem）で帯域を絞っていればその値（既定100Mbps）、
    無ければvethの報告する値（10000）。STPのコストと show interfaces のBWに使う（2026-10-14〜）。
    tcを毎秒呼ばないよう10秒覚えておく"""
    now = time.time()
    cached = _speed_cache.get(name)
    if cached and now - cached[0] < 10:
        return cached[1]
    if name.startswith('po'):  # port-channelはメンバーの合計
        slaves = (read_sys(f'/sys/class/net/{name}/bonding/slaves', '') or '').split()
        speed = sum(port_speed(m) for m in slaves if carrier(m)) or 10000
        _speed_cache[name] = (now, speed)
        return speed
    speed = None
    try:
        for q in json.loads(sh('tc', '-j', 'qdisc', 'show', 'dev', name).stdout or '[]'):
            rate = (q.get('options') or {}).get('rate', {}).get('rate') if q.get('kind') == 'netem' else None
            if rate:
                speed = max(1, round(rate * 8 / 1_000_000))
    except (ValueError, AttributeError):
        pass
    if speed is None:
        try:
            speed = int(read_sys(f'/sys/class/net/{name}/speed', '10000'))
        except ValueError:
            speed = 10000
        if speed <= 0:
            speed = 10000
    _speed_cache[name] = (now, speed)
    return speed


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
RECOVERING = f'{RUN_DIR}/recovering'  # CLIがshutdownでerr-disabledを解除したポート（エージェントが読んで消す）


def load_errdisabled():
    """err-disabledのポート → 理由（bpduguard / psecure-violation）"""
    try:
        with open(ERRDISABLED) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if isinstance(data, list):  # 2026-10-14の:3/:4はポート名の一覧だった
        return {n: 'bpduguard' for n in data}
    return data if isinstance(data, dict) else {}


def save_errdisabled(reasons):
    save(ERRDISABLED, reasons)


# GUIの「ケーブルを抜く」（2026-10-14〜）。抜かれたポート名を1行ずつ書いたファイルで、GUIがexecで書き換える。
# vethはどちらかの端をdownにすると相手側がNO-CARRIERになるので、ここに書かれたポートはdownのままにする
# （エージェントは普段shutdownしていないポートを上げ直すため、別に覚えておく必要がある）。
# 表示はshutdown（disabled）ではなく、ケーブルが抜けた時と同じnotconnectにする
UNPLUGGED = f'{RUN_DIR}/unplugged'


def load_unplugged():
    try:
        with open(UNPLUGGED) as f:
            return set(f.read().split())
    except OSError:
        return set()


# ---------------------------------------------------------------------------
# ログ（Cisco風のsyslogメッセージ、2026-10-14〜）。エージェントとCLIが追記し、CLIはコンソールに流す
# （logging console）。show loggingで見られる。大きくなったらlog.1に回す
# ---------------------------------------------------------------------------

LOG_FILE = f'{RUN_DIR}/log'
LOG_OLD = f'{RUN_DIR}/log.1'
LOG_ROTATE_BYTES = 64 * 1024


def log_event(msg):
    now = time.time()
    stamp = time.strftime('%b %d %H:%M:%S', time.localtime(now)) + f'.{int(now % 1 * 1000):03d}'
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(LOG_FILE, 'a') as f:
            f.write(f'*{stamp}: {msg}\n')
    except OSError:
        pass


def rotate_log():
    try:
        if os.path.getsize(LOG_FILE) > LOG_ROTATE_BYTES:
            os.replace(LOG_FILE, LOG_OLD)
    except OSError:
        pass


def read_log_lines():
    lines = []
    for path in (LOG_OLD, LOG_FILE):
        try:
            with open(path) as f:
                lines += f.read().splitlines()
        except OSError:
            pass
    return lines


def disp(name):
    """表示用のインターフェース名（po1 → Po1、vlan10 → Vlan10）"""
    for prefix, label in (('po', 'Po'), ('vlan', 'Vlan')):
        if name.startswith(prefix) and name[len(prefix):].isdigit():
            return label + name[len(prefix):]
    return name


def log_link_change(name, before, after):
    """ポートの状態（connected/notconnect/disabled/err-disabled）が変わった時のメッセージ"""
    n = disp(name)
    if after == 'connected':
        log_event(f'%LINK-3-UPDOWN: Interface {n}, changed state to up')
        log_event(f'%LINEPROTO-5-UPDOWN: Line protocol on Interface {n}, changed state to up')
        return
    if before == 'connected':
        log_event(f'%LINEPROTO-5-UPDOWN: Line protocol on Interface {n}, changed state to down')
    if after == 'disabled':
        log_event(f'%LINK-5-CHANGED: Interface {n}, changed state to administratively down')
    elif before in ('connected', 'disabled'):
        log_event(f'%LINK-3-UPDOWN: Interface {n}, changed state to down')


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


BPDU_MAC = '01:80:c2:00:00:00'
LLDP_MAC = '01:80:c2:00:00:0e'
CDP_MAC = '01:00:0c:cc:cc:cc'


def prepare_port(name):
    """ブリッジに入れる前に、入口でBPDUを捨てるフィルタを付ける（mstpdはその手前のタップで受け取る）。
    CDPもスイッチが受け取って終わりにする（ブリッジはCDPの宛先MACを転送してしまうため。lldpdはタップで受け取る）"""
    sh('tc', 'qdisc', 'add', 'dev', name, 'clsact')
    sh('tc', 'filter', 'add', 'dev', name, 'ingress', 'protocol', 'all', 'pref', '1',
       'flower', 'dst_mac', BPDU_MAC, 'action', 'drop')
    sh('tc', 'filter', 'add', 'dev', name, 'ingress', 'protocol', 'all', 'pref', '2',
       'flower', 'dst_mac', CDP_MAC, 'action', 'drop')


def is_up_flag(name):
    try:
        return bool(int(read_sys(f'/sys/class/net/{name}/flags', '0x0'), 16) & 1)
    except ValueError:
        return False


def carrier(name):
    return read_sys(f'/sys/class/net/{name}/carrier') == '1'


STATS_KEYS = ('rx_packets', 'rx_bytes', 'rx_dropped', 'rx_errors', 'rx_crc_errors', 'multicast',
              'tx_packets', 'tx_bytes', 'tx_dropped', 'tx_errors', 'collisions')
RATES = f'{RUN_DIR}/rates.json'
COUNTERS_BASE = f'{RUN_DIR}/counters.json'


def read_stats(name):
    out = {}
    for k in STATS_KEYS:
        try:
            out[k] = int(read_sys(f'/sys/class/net/{name}/statistics/{k}', '0'))
        except ValueError:
            out[k] = 0
    return out


# ---- LLDP / CDP（2026-10-14〜） ----
# lldpdを動かし、LLDPとCDPv2の両方を送受信する。Ciscoと同じく既定はCDPだけ有効（cdp run）、
# LLDPは lldp run で有効にする。止める時はlldpdはそのままで、送信はポートの出口（tc）でフレームを捨て、
# 受信は表示しないことで実現する（lldpdはプロトコルごとに止められないため）

LLDP_PLATFORM = 'FNL-L2SW'


def discovery_view(cfg):
    d = cfg.get('discovery', {})
    return {'lldp': d.get('lldp', False), 'cdp': d.get('cdp', True)}


class LldpAgent:
    # lldpdは30秒ごとに送る。これだけ送信数が増えなければ止まっているとみなす
    STALL_SEC = 75

    def __init__(self):
        self.proc = None
        self.hostname = None
        self.filters = {}  # ポート → (ifindex, LLDPを止めるか, CDPを止めるか)
        self.last_check = 0
        self.last_tx = None
        self.tx_at = 0

    def tick(self, cfg, ports):
        if self.proc is None or self.proc.poll() is not None:
            # -ccc：CDPv2を常に送る、-l：LLDPを常に送る、-H 0：同じ相手からのLLDPとCDPを両方残す
            self.proc = subprocess.Popen(
                ['lldpd', '-d', '-ccc', '-l', '-H', '0', '-k', '-I', 'eth*,!eth0', '-P', LLDP_PLATFORM,
                 '-S', 'Free-Networking-labs L2 switch'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            self.hostname = None
            self.last_tx, self.tx_at = None, time.time()
            return
        if self.stalled(ports):
            # lldpdは監視役と本体の2つのプロセスなので、まとめて止める
            for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, None)):
                try:
                    os.killpg(self.proc.pid, sig)
                    self.proc.wait(wait)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            self.proc = None
            return
        if self.hostname != cfg['hostname']:
            r = sh('lldpcli', 'configure', 'system', 'hostname', cfg['hostname'])
            if r.returncode == 0:
                sh('lldpcli', 'configure', 'lldp', 'portidsubtype', 'ifname')
                sh('lldpcli', 'configure', 'system', 'capabilities', 'enabled', 'bridge')
                sh('lldpcli', 'configure', 'system', 'ip', 'management', 'pattern', 'vlan*')
                self.hostname = cfg['hostname']
        g = discovery_view(cfg)
        for name in ports:
            p = port_view(cfg, name)
            want = (read_sys(f'/sys/class/net/{name}/ifindex'), not (g['lldp'] and p['lldp_tx']), not (g['cdp'] and p['cdp']))
            if self.filters.get(name) == want:
                continue
            sh('tc', 'qdisc', 'add', 'dev', name, 'clsact')
            for pref, mac, drop in (('3', LLDP_MAC, want[1]), ('4', CDP_MAC, want[2])):
                sh('tc', 'filter', 'del', 'dev', name, 'egress', 'pref', pref)
                if drop:
                    sh('tc', 'filter', 'add', 'dev', name, 'egress', 'protocol', 'all', 'pref', pref,
                       'flower', 'dst_mac', mac, 'action', 'drop')
            self.filters[name] = want

    def stalled(self, ports):
        """lldpdが送らなくなっていないか（30秒ごとに確かめる）。ラボの起動直後、ポートが組み上がる途中で
        lldpdが立ち上がると、送信も受信もしないまま止まることがあった（2026-10-15、本番のラボで確認。
        lldpd側の原因は未特定で、起動し直すと直る）。つながっているポートがない時は送らないので見ない"""
        now = time.time()
        if now - self.last_check < 30:
            return False
        self.last_check = now
        if not any(carrier(n) for n in ports):
            self.last_tx, self.tx_at = None, now
            return False
        try:
            # lldpd自体が固まっていても待ち続けないよう、時間を区切る
            r = subprocess.run(['lldpcli', '-f', 'json0', 'show', 'statistics', 'summary'],
                               capture_output=True, text=True, timeout=5)
            tx = int(json.loads(r.stdout)['lldp'][0]['summary'][0]['tx'][0]['tx'])
        except (subprocess.TimeoutExpired, ValueError, KeyError, IndexError, TypeError):
            tx = None
        if tx is not None and tx != self.last_tx:
            self.last_tx, self.tx_at = tx, now
            return False
        return now - self.tx_at > self.STALL_SEC


def parse_age(text):
    m = re.match(r'(\d+) days?, (\d+):(\d+):(\d+)', text or '')
    if not m:
        return 0
    d, h, mi, se = (int(x) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + se


def neighbors(cfg, protocol):
    """lldpdの近隣情報のうち、protocol（'LLDP' / 'CDP'）で受け取ったもの"""
    r = sh('lldpcli', '-f', 'json0', 'show', 'neighbors', 'details')
    try:
        ifaces = json.loads(r.stdout)['lldp'][0].get('interface', [])
    except (ValueError, KeyError, IndexError):
        return []
    v0 = lambda lst, key='value', default='': (lst or [{}])[0].get(key, default)  # noqa: E731
    out = []
    for i in ifaces:
        if not i.get('via', '').startswith(protocol):
            continue
        p = port_view(cfg, i['name'])
        if (protocol == 'LLDP' and not p['lldp_rx']) or (protocol == 'CDP' and not p['cdp']):
            continue
        ch = (i.get('chassis') or [{}])[0]
        po = (i.get('port') or [{}])[0]
        descr = v0(ch.get('descr'))
        ttl = int(v0(po.get('ttl'), default='120') or 120)
        out.append({
            'local': i['name'], 'name': v0(ch.get('name')) or v0(ch.get('id')), 'chassis_id': v0(ch.get('id')),
            'port': v0(po.get('id')), 'port_descr': v0(po.get('descr')), 'descr': descr,
            'platform': descr.split(' running on')[0] if ' running on' in descr else '',
            'hold': max(0, ttl - parse_age(i.get('age'))),
            'caps': [c['type'] for c in ch.get('capability', [])],
            'enabled': [c['type'] for c in ch.get('capability', []) if c.get('enabled')],
            'mgmt': [m.get('value') for m in ch.get('mgmt-ip', []) if ':' not in m.get('value', '')],
        })
    return sorted(out, key=lambda n: (iface_key(n['local']), n['name']))


LLDP_CAP = {'Router': 'R', 'Bridge': 'B', 'Telephone': 'T', 'Docsis': 'C', 'Wlan': 'W', 'Repeater': 'P', 'Station': 'S', 'Other': 'O'}
CDP_CAP = {'Router': 'R', 'Bridge': 'S', 'Telephone': 'P', 'Repeater': 'r', 'Station': 'H'}


def show_lldp_neighbors(cfg, detail=False):
    if not discovery_view(cfg)['lldp']:
        return '% LLDP is not enabled'
    ns = neighbors(cfg, 'LLDP')
    if detail:
        out = []
        for n in ns:
            out += ['------------------------------------------------', f'Local Intf: {n["local"]}',
                    f'Chassis id: {cisco_mac(n["chassis_id"])}', f'Port id: {n["port"]}',
                    f'Port Description: {n["port_descr"]}', f'System Name: {n["name"]}', '', 'System Description:',
                    n['descr'], '', f'Time remaining: {n["hold"]} seconds',
                    'System Capabilities: ' + ','.join(LLDP_CAP.get(c, 'O') for c in n['caps']),
                    'Enabled Capabilities: ' + ','.join(LLDP_CAP.get(c, 'O') for c in n['enabled']),
                    'Management Addresses:'] + ([f'    IP: {ip}' for ip in n['mgmt']] or ['    - not advertised']) + ['']
        return '\n'.join(out + [f'Total entries displayed: {len(ns)}'])
    out = ['Capability codes:', '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
           '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other', '',
           f'{"Device ID":<21}{"Local Intf":<15}{"Hold-time":<11}{"Capability":<16}Port ID']
    out += [f'{n["name"][:20]:<21}{n["local"]:<15}{n["hold"]:<11}{",".join(LLDP_CAP.get(c, "O") for c in n["enabled"]):<16}{n["port"]}'
            for n in ns]
    return '\n'.join(out + ['', f'Total entries displayed: {len(ns)}'])


def show_cdp_neighbors(cfg, detail=False):
    if not discovery_view(cfg)['cdp']:
        return '% CDP is not enabled'
    ns = neighbors(cfg, 'CDP')
    if detail:
        out = []
        for n in ns:
            caps = ' '.join({'Router': 'Router', 'Bridge': 'Switch', 'Station': 'Host'}.get(c, c) for c in n['enabled'])
            out += ['-------------------------', f'Device ID: {n["name"]}', 'Entry address(es): ']
            out += [f'  IP address: {ip}' for ip in n['mgmt']]
            out += [f'Platform: {n["platform"] or "unknown"},  Capabilities: {caps}',
                    f'Interface: {n["local"]},  Port ID (outgoing port): {n["port"]}', f'Holdtime : {n["hold"]} sec', '',
                    'Version :', n['descr'].split('running on')[-1].strip(), '']
        return '\n'.join(out + [f'Total cdp entries displayed : {len(ns)}'])
    out = ['Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
           '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone', '',
           f'{"Device ID":<17}{"Local Intrfce":<18}{"Holdtme":<11}{"Capability":<12}{"Platform":<10}Port ID']
    out += [f'{n["name"][:16]:<17}{n["local"]:<18}{n["hold"]:<11}{" ".join(CDP_CAP.get(c, "") for c in n["enabled"]):<12}'
            f'{(n["platform"] or "")[:9]:<10}{n["port"]}' for n in ns]
    return '\n'.join(out + ['', f'Total cdp entries displayed : {len(ns)}'])


def show_lldp(cfg):
    if not discovery_view(cfg)['lldp']:
        return '% LLDP is not enabled'
    return '\n'.join(['', 'Global LLDP Information:', '    Status: ACTIVE', '    LLDP advertisements are sent every 30 seconds',
                      '    LLDP hold time advertised is 120 seconds', '    LLDP interface reinitialisation delay is 2 seconds'])


def show_cdp(cfg):
    if not discovery_view(cfg)['cdp']:
        return '% CDP is not enabled'
    return '\n'.join(['Global CDP information:', '        Sending CDP packets every 30 seconds',
                      '        Sending a holdtime value of 120 seconds', '        Sending CDPv2 advertisements is  enabled'])


# ---- ポートセキュリティ（2026-10-14〜） ----
# ブリッジのポートを locked（知らない送信元MACのフレームを捨てる）＋ mab（その時に「locked」のエントリを
# 作って知らせる）にし、エージェントがそのエントリを見て、上限以内なら固定のエントリ（static）にして通す。
# 上限を超えたら違反（protect：捨てるだけ、restrict：捨てて数える・ログ、shutdown：err-disabled）

PSEC_STATE = f'{RUN_DIR}/psec.json'


def psec_state():
    return read_json(PSEC_STATE, {})


class PsecAgent:
    def __init__(self):
        self.flags = {}  # ポート → locked/mabを入れたか
        self.applied = {}  # ポート → 入れた固定エントリ {(mac, vlan)}
        self.last_seen = {}  # (ポート, mac) → 最後に違反として数えた時刻

    def tick(self, cfg, errdisabled):
        state = psec_state()
        before = json.dumps(state, sort_keys=True)
        locked = {}
        need_fdb = any(port_view(cfg, n)['psec']['enabled'] for n in system_ports())
        if need_fdb or self.applied:
            try:
                for e in json.loads(sh('bridge', '-j', 'fdb', 'show', 'br', BRIDGE).stdout or '[]'):
                    if 'locked' in e.get('flags', []):
                        locked.setdefault(e.get('ifname'), []).append((e.get('mac'), e.get('vlan', 1)))
            except ValueError:
                pass
        sticky_add = {}
        for name in system_ports():
            p = port_view(cfg, name)
            ps = p['psec']
            on = ps['enabled'] and p['mode'] == 'access' and not member_of(cfg, name)
            if self.flags.get(name) != on:
                sh('bridge', 'link', 'set', 'dev', name, 'locked', 'on' if on else 'off', 'mab', 'on' if on else 'off')
                self.flags[name] = on
            st = state.setdefault(name, {'dynamic': [], 'violations': 0, 'last': ''})
            vlan = p['access_vlan']
            if not on:
                st['dynamic'] = []
                self.reconcile(name, set())
                if not st['violations'] and not st['last']:
                    state.pop(name)
                continue
            # リンクが落ちたら学習済み（dynamic）の安全なMACは消える（Ciscoと同じ。stickyと固定は残る）
            if link_status(name, p) != 'connected':
                st['dynamic'] = []
            secure = {(parse_mac(m['mac']), vlan) for m in ps['macs']} | {(m, vlan) for m in st['dynamic']}
            for mac, v in locked.get(name, []):
                sh('bridge', 'fdb', 'del', mac, 'dev', name, 'master', 'vlan', str(v))
                if (mac, v) in secure:
                    continue
                if v == vlan and len(secure) < ps['max']:
                    secure.add((mac, v))
                    st['last'] = f'{mac}:{v}'
                    if ps['sticky']:
                        sticky_add.setdefault(name, []).append(mac)
                    else:
                        st['dynamic'].append(mac)
                    continue
                # 違反
                if ps['violation'] == 'protect':
                    continue
                now = time.time()
                if now - self.last_seen.get((name, mac), 0) < 1:
                    continue
                self.last_seen[(name, mac)] = now
                st['violations'] += 1
                st['last'] = f'{mac}:{v}'
                log_event(f'%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address '
                          f'{cisco_mac(mac)} on port {name}.')
                if ps['violation'] == 'shutdown' and name not in errdisabled:
                    errdisabled[name] = 'psecure-violation'
                    save_errdisabled(errdisabled)
                    sh('ip', 'link', 'set', name, 'down')
                    log_event(f'%PM-4-ERR_DISABLE: psecure-violation error detected on {name}, putting {name} in err-disable state')
                    st['dynamic'] = []
                    secure = {(parse_mac(m['mac']), vlan) for m in ps['macs']}
                    break
            self.reconcile(name, secure)
        if sticky_add:
            # stickyで覚えたMACはrunning-configに入る（write memoryすれば残る。Ciscoと同じ）
            run = load(RUNNING)
            for name, macs in sticky_add.items():
                ps = port_cfg(run, name).setdefault('psec', {})
                lst = ps.setdefault('macs', [])
                for mac in macs:
                    if not any(parse_mac(m['mac']) == mac for m in lst):
                        lst.append({'mac': mac, 'sticky': True})
            save(RUNNING, run)
        if json.dumps(state, sort_keys=True) != before:
            save(PSEC_STATE, state)

    def reconcile(self, name, want):
        have = self.applied.get(name, set())
        for mac, v in have - want:
            sh('bridge', 'fdb', 'del', mac, 'dev', name, 'master', 'vlan', str(v))
        for mac, v in want - have:
            sh('bridge', 'fdb', 'replace', mac, 'dev', name, 'master', 'static', 'vlan', str(v))
        if want:
            self.applied[name] = set(want)
        else:
            self.applied.pop(name, None)


def bond_info(po):
    """bondの設定（mode・lacp_active）。無ければNone"""
    if not os.path.exists(f'/sys/class/net/{po}'):
        return None
    # sysfsの値は「802.3ad 4」「on 1」の形
    return {'mode': (read_sys(f'/sys/class/net/{po}/bonding/mode', '') or '').split(' ')[0],
            'lacp_active': (read_sys(f'/sys/class/net/{po}/bonding/lacp_active', '') or '').split(' ')[0]}


def read_bonding(po):
    """/proc/net/bonding/poN を読む。{'active_agg': 1, 'slaves': {'eth1': {...}}}"""
    try:
        with open(f'/proc/net/bonding/{po}') as f:
            text = f.read()
    except OSError:
        return {'active_agg': None, 'slaves': {}}
    result = {'active_agg': None, 'slaves': {}}
    m = re.search(r'Active Aggregator Info:\s*\n\s*Aggregator ID: (\d+)', text)
    if m:
        result['active_agg'] = int(m.group(1))
    for block in text.split('Slave Interface: ')[1:]:
        name = block.split('\n', 1)[0].strip()
        sl = {'mii': re.search(r'MII Status: (\w+)', block).group(1) if re.search(r'MII Status: (\w+)', block) else 'down'}
        m = re.search(r'Aggregator ID: (\d+)', block)
        sl['agg'] = int(m.group(1)) if m else None
        for side in ('actor', 'partner'):
            part = block.split(f'details {side} lacp pdu:')[-1] if f'details {side} lacp pdu:' in block else ''
            get = lambda key: (re.search(key + r': ([^\n]+)', part) or [None, None])[1]  # noqa: E731
            sl[side] = {'mac': (get('system mac address') or '').strip(), 'key': (get('oper key') or '').strip(),
                        'prio': (get('port priority') or '').strip(), 'port': (get('port number') or '').strip(),
                        'state': int((get('port state') or '0').strip() or 0)}
        result['slaves'][name] = sl
    return result


def lacp_member_state(cfg, po, member, bonding=None):
    """メンバーの状態（show etherchannel summaryの記号）：P＝まとまっている、D＝リンクダウン、
    I＝相手がLACPを話さず単独、s＝まとまれない（別の集約に入った）"""
    groups = channel_groups(cfg)
    n = int(po[2:])
    if n not in groups or not os.path.exists(f'/sys/class/net/{member}'):
        return 'D'
    if not carrier(member) or link_status(member, port_view(cfg, member)) != 'connected':
        return 'D'
    b = bonding or read_bonding(po)
    sl = b['slaves'].get(member)
    if not sl or sl['mii'] != 'up':
        return 'D'
    if groups[n]['mode'] == 'on':
        return 'P'
    if sl['partner']['mac'] in ('', '00:00:00:00:00:00'):
        return 'I'
    if sl['agg'] != b['active_agg']:
        return 's'
    return 'P' if sl['actor']['state'] & 0x3c == 0x3c else 'w'


class Agent:
    """running-configをbr0とカーネルに反映し続ける（swcli --agent、コンテナのメイン）"""

    def __init__(self):
        self.stp = StpAgent()
        # err-disabledからshutdownで戻したポート。mstpdのBPDU Guardのエラーはポートが上がるまで残るので、
        # 次にno shutdownで上げる時はそれを見ずに上げる（上がるとmstpdがエラーを消す）
        self.recovering = set()
        # ポートのVLANの確認（bridge vlan show）は全VLAN許可のトランクがあると重いので、設定が変わった時・
        # ポートが増えた時と10秒ごとだけ行う（毎秒やるとスイッチ1台でCPUを数%使っていた）
        self.last_vlan_check, self.last_mtime, self.last_ports = 0.0, None, None
        self.current = {}
        self.status = {}  # ポート → 前回の状態（ログを出すため）
        self.applied_aging = None
        self.applied_static = set()  # (mac, vlan, port)
        self.last_rate = 0.0
        self.prev_stats = {}
        self.last_rotate = 0.0
        self.svi_status = {}
        self.lldp = LldpAgent()
        self.psec = PsecAgent()
        self.last_route_check = 0.0

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        os.makedirs(RUN_DIR, exist_ok=True)
        if not os.path.exists(RUNNING):
            save(RUNNING, load(STARTUP) if os.path.exists(STARTUP) else default_config())
        while True:
            try:
                self.step()
            except Exception as e:  # 1回の失敗で止まらないように
                print(f'agent: {e}', file=sys.stderr)
            time.sleep(1)

    def step(self):
        if not os.path.exists(f'/sys/class/net/{BRIDGE}'):
            # カーネルのSTPは使わず（stp_state 0）、mstpdの決めた状態をMSTのポート状態として入れる
            sh('ip', 'link', 'add', BRIDGE, 'type', 'bridge', 'stp_state', '0', 'vlan_filtering', '1', 'mst_enabled', '1')
        if not is_up_flag(BRIDGE):
            sh('ip', 'link', 'set', BRIDGE, 'up')
        cfg = load(RUNNING)
        mtime = os.path.getmtime(RUNNING) if os.path.exists(RUNNING) else None
        self.sync_bonds(cfg)
        ports = bridge_ports(cfg)  # ブリッジに入るポート（channel-groupのメンバーの代わりにpoN）
        check_vlans = mtime != self.last_mtime or ports != self.last_ports or time.time() - self.last_vlan_check > 10
        if check_vlans:
            self.current = current_vlans()
            self.last_vlan_check, self.last_mtime, self.last_ports = time.time(), mtime, ports
        changed = self.sync_ports(cfg, ports, check_vlans)
        self.stp.tick(cfg, ports, changed)
        self.sync_mac(cfg)
        self.sync_svi(cfg)
        self.lldp.tick(cfg, system_ports())
        self.psec.tick(cfg, load_errdisabled())
        self.sample_rates(system_ports() + [n for n in ports if n.startswith('po')])
        if time.time() - self.last_rotate > 30:
            rotate_log()
            self.last_rotate = time.time()

    def sync_ports(self, cfg, ports, check_vlans):
        """ethの上げ下げ（shutdown・ケーブルを抜く・err-disabled）と、ブリッジのポート（ports）のVLAN"""
        try:
            with open(RECOVERING) as f:
                self.recovering |= set(f.read().split())
            os.remove(RECOVERING)
        except OSError:
            pass
        errdisabled = load_errdisabled()
        before = dict(errdisabled)
        unplugged = load_unplugged()
        changed = False
        for name in ports:
            if not os.path.exists(f'/sys/class/net/{name}'):
                continue
            if not os.path.exists(f'/sys/class/net/{name}/master'):
                prepare_port(name)
                sh('ip', 'link', 'set', name, 'master', BRIDGE)
                if check_vlans:
                    self.current[name] = set()
            if name.startswith('po'):
                p = port_view(cfg, name)
                if is_up_flag(name) == p['shutdown']:
                    sh('ip', 'link', 'set', name, 'down' if p['shutdown'] else 'up')
            if check_vlans and self.current.get(name, set()) != desired_vlans(port_view(cfg, name)):
                apply_port(name, port_view(cfg, name))
                changed = True
        for name in system_ports():
            p = port_view(cfg, name)
            if member_of(cfg, name) and not os.path.exists(f'/sys/class/net/{name}/master'):
                continue  # これからbondに入れる（sync_bonds）
            is_up = is_up_flag(name)
            if p['shutdown']:
                if name in errdisabled:  # Ciscoと同じく shutdown → no shutdown でerr-disabledから戻す
                    errdisabled.pop(name)
                    self.recovering.add(name)
                if is_up:
                    sh('ip', 'link', 'set', name, 'down')
            elif name in unplugged:
                if is_up:
                    sh('ip', 'link', 'set', name, 'down')
            elif name in errdisabled:
                if is_up:
                    sh('ip', 'link', 'set', name, 'down')
            elif not is_up:
                # BPDU Guardで止められたポート（mstpdがdownにする）は、err-disabledとして落としたままにする
                if name not in self.recovering and bpdu_guard_error(name):
                    errdisabled[name] = 'bpduguard'
                    log_event(f'%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port {name} with BPDU Guard enabled. Disabling port.')
                    log_event(f'%PM-4-ERR_DISABLE: bpduguard error detected on {name}, putting {name} in err-disable state')
                else:
                    sh('ip', 'link', 'set', name, 'up')
                    self.recovering.discard(name)
        if errdisabled != before:
            save_errdisabled(errdisabled)
        self.log_status_changes(cfg, sorted(set(system_ports()) | set(ports), key=iface_key), errdisabled, unplugged)
        return changed

    def sync_bonds(self, cfg):
        """channel-groupをbond（poN）に反映する"""
        groups = channel_groups(cfg)
        for n, g in groups.items():
            po = f'po{n}'
            kind = 'balance-xor' if g['mode'] == 'on' else '802.3ad'
            lacp_active = 'off' if g['mode'] == 'passive' else 'on'
            info = bond_info(po)
            if info is not None and (info.get('mode') != kind or (kind == '802.3ad' and info.get('lacp_active') != lacp_active)):
                sh('ip', 'link', 'del', po)  # モードはメンバーがいると変えられないので作り直す
                info = None
            if info is None:
                args = ['ip', 'link', 'add', po, 'type', 'bond', 'mode', kind, 'miimon', '100', 'xmit_hash_policy', 'layer2+3']
                if kind == '802.3ad':
                    args += ['lacp_active', lacp_active]
                sh(*args)
                self.last_vlan_check = 0.0
            for m in g['members']:
                if not os.path.exists(f'/sys/class/net/{m}'):
                    continue
                if os.path.basename(os.path.realpath(f'/sys/class/net/{m}/master')) != po:
                    up = is_up_flag(m)
                    sh('ip', 'link', 'set', m, 'down')
                    sh('ip', 'link', 'set', m, 'nomaster')
                    # BPDUはbondに届けてから捨てる（mstpdはpoNで受け取る）。メンバーの入口では捨てない
                    sh('tc', 'filter', 'del', 'dev', m, 'ingress', 'pref', '1')
                    sh('ip', 'link', 'set', m, 'master', po)
                    if up:
                        sh('ip', 'link', 'set', m, 'up')
        members = {m for g in groups.values() for m in g['members']}
        for name in system_ports():
            master = os.path.basename(os.path.realpath(f'/sys/class/net/{name}/master')) if os.path.exists(f'/sys/class/net/{name}/master') else None
            if master and master.startswith('po') and name not in members:
                sh('ip', 'link', 'set', name, 'nomaster')  # channel-groupから外した。次のsync_portsでブリッジに戻す
        for name in os.listdir('/sys/class/net'):
            m = re.fullmatch(r'po(\d+)', name)
            if m and int(m.group(1)) not in groups:
                sh('ip', 'link', 'del', name)
        self.log_bundles(cfg, groups)

    def log_bundles(self, cfg, groups):
        now = set()
        for n, g in groups.items():
            for m in g['members']:
                if lacp_member_state(cfg, f'po{n}', m) == 'P':
                    now.add((m, n))
        before = getattr(self, 'bundled', None)
        if before is not None:
            for m, n in sorted(now - before):
                log_event(f'%EC-5-BUNDLE: Interface {m} joined port-channel Po{n}')
            for m, n in sorted(before - now):
                log_event(f'%EC-5-UNBUNDLE: Interface {m} left the port-channel Po{n}')
        self.bundled = now

    def log_status_changes(self, cfg, ports, errdisabled, unplugged):
        for name in ports:
            now = port_status(name, port_view(cfg, name), errdisabled, unplugged)
            before = self.status.get(name)
            if before is not None and before != now:
                log_link_change(name, before, now)
            self.status[name] = now
        for name in list(self.status):
            if name not in ports:
                self.status.pop(name)

    def sync_mac(self, cfg):
        m = mac_view(cfg)
        if m['aging'] != self.applied_aging:
            sh('ip', 'link', 'set', BRIDGE, 'type', 'bridge', 'ageing_time', str(m['aging'] * 100))
            self.applied_aging = m['aging']
        want = {(e['mac'], e['vlan'], e['iface']) for e in m['static'] if os.path.exists(f'/sys/class/net/{e["iface"]}')}
        for mac, vlan, port in self.applied_static - want:
            sh('bridge', 'fdb', 'del', mac, 'dev', port, 'master', 'vlan', str(vlan))
        for mac, vlan, port in want - self.applied_static:
            sh('bridge', 'fdb', 'replace', mac, 'dev', port, 'master', 'static', 'vlan', str(vlan))
        self.applied_static = want

    def sync_svi(self, cfg):
        """interface vlan N（vlanNデバイス）とip default-gatewayを反映する"""
        want = set(svi_ids(cfg))
        self_vlans = {v for v, _ in self.current.get(BRIDGE, set())} if self.current else set()
        self_untagged = {v for v, u in self.current.get(BRIDGE, set()) if u} if self.current else set()
        for vid in want:
            dev = f'vlan{vid}'
            v = svi_view(cfg, vid)
            if not os.path.exists(f'/sys/class/net/{dev}'):
                sh('ip', 'link', 'add', 'link', BRIDGE, 'name', dev, 'type', 'vlan', 'id', str(vid))
            # ブリッジ自身にVLAN vidをタグ付きで通す（タグなし（PVID）だとvlanNデバイスに届かない）
            if vid not in self_vlans or vid in self_untagged:
                sh('bridge', 'vlan', 'del', 'dev', BRIDGE, 'vid', str(vid), 'self')
                sh('bridge', 'vlan', 'add', 'dev', BRIDGE, 'vid', str(vid), 'self')
                self.last_vlan_check = 0.0
            have = []
            try:
                for e in json.loads(sh('ip', '-j', '-4', 'addr', 'show', 'dev', dev).stdout or '[]'):
                    have += [f'{a["local"]}/{a["prefixlen"]}' for a in e.get('addr_info', [])]
            except (ValueError, KeyError):
                pass
            if have != ([v['address']] if v['address'] else []):
                sh('ip', '-4', 'addr', 'flush', 'dev', dev)
                if v['address']:
                    sh('ip', 'addr', 'add', v['address'], 'dev', dev)
            if is_up_flag(dev) == v['shutdown']:
                sh('ip', 'link', 'set', dev, 'down' if v['shutdown'] else 'up')
            now = svi_status(cfg, vid)
            before = self.svi_status.get(vid)
            if before is not None and before != now:
                log_link_change(dev, before, now)
            self.svi_status[vid] = now
        for name in os.listdir('/sys/class/net'):
            m = re.fullmatch(r'vlan(\d+)', name)
            if m and int(m.group(1)) not in want:
                sh('ip', 'link', 'del', name)
                self.svi_status.pop(int(m.group(1)), None)
        # スイッチはラボ内の機器なので、containerlabが付ける管理ネットワーク（eth0）経由のデフォルトルートは
        # 消し、ip default-gatewayの設定だけにする（PCと同じ扱い）。経路の確認は5秒ごと
        if time.time() - self.last_route_check < 5:
            return
        self.last_route_check = time.time()
        try:
            routes = json.loads(sh('ip', '-j', '-4', 'route', 'show', 'default').stdout or '[]')
        except ValueError:
            routes = []
        gw = cfg.get('default_gateway')
        for r in routes:
            if r.get('dev') == 'eth0' or r.get('gateway') != gw:
                sh('ip', 'route', 'del', 'default', 'via', r.get('gateway', ''), 'dev', r.get('dev', ''))
        if gw and not any(r.get('gateway') == gw and r.get('dev') != 'eth0' for r in routes):
            sh('ip', 'route', 'replace', 'default', 'via', gw)

    def sample_rates(self, ports):
        """show interfaces の「5 second input/output rate」用に、5秒ごとの送受信量を残す"""
        now = time.time()
        if now - self.last_rate < 5:
            return
        rates = {}
        for name in ports:
            st = read_stats(name)
            prev = self.prev_stats.get(name)
            if prev:
                dt = max(now - prev[0], 0.001)
                d = {k: max(0, st[k] - prev[1][k]) for k in ('rx_bytes', 'rx_packets', 'tx_bytes', 'tx_packets')}
                rates[name] = [round(d['rx_bytes'] * 8 / dt), round(d['rx_packets'] / dt),
                               round(d['tx_bytes'] * 8 / dt), round(d['tx_packets'] / dt)]
            self.prev_stats[name] = (now, st)
        self.last_rate = now
        save(RATES, rates)


def agent():
    Agent().run()


# ---------------------------------------------------------------------------
# show系
# ---------------------------------------------------------------------------

def port_status(name, p, errdisabled, unplugged):
    if p['shutdown']:
        return 'disabled'
    if name in errdisabled:
        return 'err-disabled'
    if name in unplugged:
        return 'notconnect'
    return 'connected' if carrier(name) else 'notconnect'


def link_status(name, p):
    return port_status(name, p, load_errdisabled(), load_unplugged())


def cisco_mac(mac):
    m = mac.replace(':', '').replace('.', '').replace('-', '').lower()
    return '.'.join(m[i:i + 4] for i in range(0, 12, 4)) if len(m) == 12 else mac


def parse_mac(text):
    """aabb.ccdd.eeff / aa:bb:cc:dd:ee:ff → aa:bb:cc:dd:ee:ff（不正ならNone）"""
    m = re.sub(r'[.:-]', '', text.lower())
    if not re.fullmatch(r'[0-9a-f]{12}', m):
        return None
    return ':'.join(m[i:i + 2] for i in range(0, 12, 2))


# ---- show interfaces ----

def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def counters(name):
    """clear counters からの値（コンテナの起動からの値から、clear countersした時の値を引く）"""
    now = read_stats(name)
    base = read_json(COUNTERS_BASE, {}).get(name, {})
    if any(now[k] < base.get(k, 0) for k in now):  # I/Fが作り直された
        base = {}
    return {k: now[k] - base.get(k, 0) for k in now}


def show_interface_detail(cfg, name):
    p = port_view(cfg, name)
    status = link_status(name, p)
    head = {'connected': 'is up, line protocol is up (connected)',
            'disabled': 'is administratively down, line protocol is down (disabled)',
            'err-disabled': 'is down, line protocol is down (err-disabled)'}.get(
        status, 'is down, line protocol is down (notconnect)')
    mac = cisco_mac(read_sys(f'/sys/class/net/{name}/address', '') or '')
    speed = port_speed(name)
    c = counters(name)
    rate = read_json(RATES, {}).get(name, [0, 0, 0, 0])
    speed_text = f'{speed // 1000}Gb/s' if speed >= 1000 and speed % 1000 == 0 else f'{speed}Mb/s'
    out = [f'{disp(name)} {head}', f'  Hardware is Ethernet, address is {mac} (bia {mac})']
    if p['description']:
        out.append(f'  Description: {p["description"]}')
    out += [f'  MTU {read_sys(f"/sys/class/net/{name}/mtu", "1500")} bytes, BW {speed * 1000} Kbit/sec, DLY 100 usec,',
            '  Encapsulation ARPA, loopback not set',
            f'  Full-duplex, {speed_text}, media type is veth',
            f'  5 second input rate {rate[0]} bits/sec, {rate[1]} packets/sec',
            f'  5 second output rate {rate[2]} bits/sec, {rate[3]} packets/sec',
            f'     {c["rx_packets"]} packets input, {c["rx_bytes"]} bytes, 0 no buffer',
            f'     Received {c["multicast"]} multicasts',
            f'     {c["rx_errors"]} input errors, {c["rx_crc_errors"]} CRC, 0 frame, 0 overrun, {c["rx_dropped"]} ignored',
            f'     {c["tx_packets"]} packets output, {c["tx_bytes"]} bytes, 0 underruns',
            f'     {c["tx_errors"]} output errors, {c["collisions"]} collisions, 0 interface resets',
            f'     {c["tx_dropped"]} output buffer failures, 0 output buffers swapped out']
    return '\n'.join(out)


def show_interfaces_all(cfg):
    return '\n'.join(show_interface_detail(cfg, n) for n in all_ports(cfg) if os.path.exists(f'/sys/class/net/{n}'))


def show_interfaces_counters(cfg):
    names = [n for n in all_ports(cfg) if os.path.exists(f'/sys/class/net/{n}')]
    rows = {n: counters(n) for n in names}
    out = [f'{"Port":<10}{"InOctets":>16}{"InPkts":>14}{"InMcastPkts":>14}{"InDiscards":>12}']
    out += [f'{disp(n):<10}{c["rx_bytes"]:>16}{c["rx_packets"]:>14}{c["multicast"]:>14}{c["rx_dropped"]:>12}' for n, c in rows.items()]
    out += ['', f'{"Port":<10}{"OutOctets":>16}{"OutPkts":>14}{"OutDiscards":>14}{"OutErrors":>12}']
    out += [f'{disp(n):<10}{c["tx_bytes"]:>16}{c["tx_packets"]:>14}{c["tx_dropped"]:>14}{c["tx_errors"]:>12}' for n, c in rows.items()]
    return '\n'.join(out)


def clear_counters(names):
    base = read_json(COUNTERS_BASE, {})
    for n in names:
        if os.path.exists(f'/sys/class/net/{n}'):
            base[n] = read_stats(n)
    save(COUNTERS_BASE, base)


# ---- 管理用のVLANインターフェース（SVI）・デフォルトゲートウェイ（2026-10-14〜） ----
# interface vlan N に ip address を付けると、ブリッジにVLAN Nのデバイス（vlanN）を作ってアドレスを付ける。
# Ciscoと同じく作った直後はshutdown。スイッチ自身へのping・スイッチからのpingに使う

def svi_view(cfg, vid):
    v = cfg.get('svi', {}).get(str(vid), {})
    return {'address': v.get('address'), 'shutdown': v.get('shutdown', True), 'description': v.get('description', '')}


def svi_ids(cfg):
    return sorted((int(k) for k in cfg.get('svi', {})), key=int)


def vlan_has_up_port(cfg, vid):
    """VLAN vidを通すポートのうち、つながっているものがあるか（SVIのline protocolの判定。Ciscoと同じ）"""
    for name in system_ports():
        p = port_view(cfg, name)
        if any(v == vid for v, _ in desired_vlans(p)) and link_status(name, p) == 'connected':
            return True
    return False


def svi_status(cfg, vid):
    v = svi_view(cfg, vid)
    if v['shutdown']:
        return 'disabled'
    return 'connected' if str(vid) in cfg['vlans'] and vlan_has_up_port(cfg, vid) else 'notconnect'


def mask_to_prefix(mask):
    try:
        bits = ''.join(f'{int(o):08b}' for o in mask.split('.'))
    except ValueError:
        return None
    if len(bits) != 32 or '01' in bits:
        return None
    return bits.count('1')


def prefix_to_mask(prefix):
    n = (0xffffffff << (32 - prefix)) & 0xffffffff if prefix else 0
    return '.'.join(str((n >> s) & 255) for s in (24, 16, 8, 0))


def is_ipv4(text):
    parts = text.split('.')
    return len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)


# ---- パスワード（enable secret / enable password / line console）（2026-10-14〜） ----
# enable secretはCiscoのtype 9と同じくscryptでハッシュにして持つ。enable password・コンソールの
# パスワードは平文で持ち、service password-encryptionの時だけtype 7（Ciscoの可逆の簡易暗号）で表示する

CISCO_B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def type9_hash(password, salt=None):
    import base64
    import hashlib
    import secrets
    salt = salt or ''.join(secrets.choice(CISCO_B64) for _ in range(14))
    raw = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=1, p=1, dklen=32)
    enc = base64.b64encode(raw).decode().rstrip('=').translate(str.maketrans(STD_B64, CISCO_B64))
    return f'$9${salt}${enc}'


def type9_check(password, hashed):
    try:
        salt = hashed.split('$')[2]
    except IndexError:
        return False
    return type9_hash(password, salt) == hashed


TYPE7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87'


def type7_encode(text):
    import random
    seed = random.randrange(16)
    return f'{seed:02d}' + ''.join(f'{ord(c) ^ ord(TYPE7_KEY[(seed + i) % len(TYPE7_KEY)]):02X}' for i, c in enumerate(text))


def type7_decode(text):
    try:
        seed = int(text[:2])
        return ''.join(chr(int(text[i:i + 2], 16) ^ ord(TYPE7_KEY[(seed + (i - 2) // 2) % len(TYPE7_KEY)]))
                       for i in range(2, len(text), 2))
    except (ValueError, IndexError):
        return None


def auth_view(cfg):
    a = cfg.get('auth', {})
    return {'enable_secret': a.get('enable_secret'), 'enable_password': a.get('enable_password'),
            'console_password': a.get('console_password'), 'console_login': a.get('console_login', False),
            'encryption': a.get('encryption', False), 'logging_sync': a.get('logging_sync', False)}


def show_password(cfg, plain):
    return f'7 {type7_encode(plain)}' if auth_view(cfg)['encryption'] else plain


# ---- MACアドレステーブル ----

MAC_AGING_DEFAULT = 300


def mac_view(cfg):
    m = cfg.get('mac', {})
    return {'aging': m.get('aging', MAC_AGING_DEFAULT), 'static': m.get('static', [])}


def fdb_entries():
    """学習済み（DYNAMIC）・固定（STATIC）のエントリ。ブリッジ自身のMAC・ポートのMAC・
    ポートセキュリティで止めている（locked）ものは出さない"""
    rows = []
    try:
        for e in json.loads(sh('bridge', '-j', 'fdb', 'show', 'br', BRIDGE).stdout or '[]'):
            flags = e.get('flags', [])
            state = e.get('state', '')
            if 'self' in flags or state == 'permanent' or e.get('ifname') == BRIDGE or 'locked' in flags:
                continue
            rows.append({'vlan': e.get('vlan', 1), 'mac': e.get('mac', ''), 'port': e.get('ifname', ''),
                         'type': 'STATIC' if state == 'static' else 'DYNAMIC'})
    except ValueError:
        pass
    return sorted(rows, key=lambda r: (r['vlan'], r['mac']))


def show_mac(cfg, kind=None, address=None, iface=None, vlan=None, count=False):
    rows = fdb_entries()
    if kind:
        rows = [r for r in rows if r['type'] == kind]
    if address:
        rows = [r for r in rows if r['mac'] == address]
    if iface:
        rows = [r for r in rows if r['port'] == iface]
    if vlan:
        rows = [r for r in rows if r['vlan'] == vlan]
    if count:
        dyn = sum(1 for r in rows if r['type'] == 'DYNAMIC')
        return '\n'.join(['Mac Entries for all vlans :', '---------------------------',
                          f'Dynamic Address Count  : {dyn}', f'Static  Address Count  : {len(rows) - dyn}',
                          f'Total Mac Addresses    : {len(rows)}'])
    out = ['          Mac Address Table', '-------------------------------------------', '',
           f'{"Vlan":<8}{"Mac Address":<20}{"Type":<12}Ports', '----    -----------         --------    -----']
    out += [f'{r["vlan"]:<8}{cisco_mac(r["mac"]):<20}{r["type"]:<12}{disp(r["port"])}' for r in rows]
    out.append(f'Total Mac Addresses for this criterion: {len(rows)}')
    return '\n'.join(out)


def clear_mac(address=None, iface=None, vlan=None):
    for r in fdb_entries():
        if r['type'] != 'DYNAMIC':
            continue
        if (address and r['mac'] != address) or (iface and r['port'] != iface) or (vlan and r['vlan'] != vlan):
            continue
        sh('bridge', 'fdb', 'del', r['mac'], 'dev', r['port'], 'master', 'vlan', str(r['vlan']))


def show_ip_interface_brief(cfg):
    out = [f'{"Interface":<23}{"IP-Address":<16}{"OK?":<4}{"Method":<7}{"Status":<22}Protocol']
    for vid in svi_ids(cfg):
        v = svi_view(cfg, vid)
        st = svi_status(cfg, vid)
        addr = v['address'].split('/')[0] if v['address'] else 'unassigned'
        status = 'administratively down' if st == 'disabled' else ('up' if st == 'connected' else 'down')
        out.append(f'{"Vlan" + str(vid):<23}{addr:<16}{"YES":<4}{"manual" if v["address"] else "unset":<7}{status:<22}'
                   f'{"up" if st == "connected" else "down"}')
    for name in all_ports(cfg):
        st = link_status(name, port_view(cfg, name))
        status = 'administratively down' if st == 'disabled' else ('up' if st == 'connected' else 'down')
        out.append(f'{disp(name):<23}{"unassigned":<16}{"YES":<4}{"unset":<7}{status:<22}{"up" if st == "connected" else "down"}')
    return '\n'.join(out)


def show_svi_detail(cfg, vid):
    v = svi_view(cfg, vid)
    st = svi_status(cfg, vid)
    head = {'connected': 'is up, line protocol is up', 'disabled': 'is administratively down, line protocol is down'}.get(
        st, 'is up, line protocol is down')
    mac = cisco_mac(read_sys(f'/sys/class/net/{BRIDGE}/address', '') or '')
    out = [f'Vlan{vid} {head}', f'  Hardware is EtherSVI, address is {mac} (bia {mac})']
    if v['description']:
        out.append(f'  Description: {v["description"]}')
    if v['address']:
        ip, prefix = v['address'].split('/')
        out.append(f'  Internet address is {ip}/{prefix}')
    out.append('  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,')
    return '\n'.join(out)


def show_etherchannel_summary(cfg):
    groups = channel_groups(cfg)
    out = ['Flags:  D - down        P - bundled in port-channel', '        I - stand-alone s - suspended',
           '        H - Hot-standby (LACP only)', '        R - Layer3      S - Layer2',
           '        U - in use      f - failed to allocate aggregator', '',
           '        M - not in use, minimum links not met', '        u - unsuitable for bundling',
           '        w - waiting to be aggregated', '        d - default port', '',
           f'Number of channel-groups in use: {len(groups)}', f'Number of aggregators:           {len(groups)}', '',
           'Group  Port-channel  Protocol    Ports', '------+-------------+-----------+-----------------------------------------------']
    for n, g in sorted(groups.items()):
        po = f'po{n}'
        b = read_bonding(po)
        states = [(m, lacp_member_state(cfg, po, m, b)) for m in g['members']]
        flag = 'SU' if any(st == 'P' for _, st in states) else 'SD'
        proto = 'LACP' if g['mode'] in ('active', 'passive') else '-'
        ports = ''.join(f'{m}({st})'.ljust(12) for m, st in states)
        out.append(f'{n:<7}{f"Po{n}({flag})":<16}{proto:<10}{ports.rstrip()}')
    return '\n'.join(out)


def show_lacp_neighbor(cfg):
    out = ['Flags:  S - Device is requesting Slow LACPDUs', '        F - Device is requesting Fast LACPDUs',
           '        A - Device is in Active mode       P - Device is in Passive mode']
    for n, g in sorted(channel_groups(cfg).items()):
        if g['mode'] == 'on':
            continue
        b = read_bonding(f'po{n}')
        out += ['', f'Channel group {n} neighbors', '', f'{"":18}{"LACP port":<18}{"":15}{"Admin":<7}{"Oper":<7}{"Port":<8}Port',
                f'{"Port":<10}{"Flags":<8}{"Priority":<10}{"Dev ID":<16}{"Age":<7}{"key":<7}{"Key":<7}{"Number":<8}State']
        for m in g['members']:
            pt = b['slaves'].get(m, {}).get('partner')
            if not pt or pt['mac'] in ('', '00:00:00:00:00:00'):
                continue
            flags = ('F' if pt['state'] & 0x2 else 'S') + ('A' if pt['state'] & 0x1 else 'P')
            key = int(pt['key'] or 0)
            out.append(f'{m:<10}{flags:<8}{pt["prio"]:<10}{cisco_mac(pt["mac"]):<16}{"-":<7}{"0x0":<7}{f"0x{key:X}":<7}'
                       f'{f"0x{int(pt["port"] or 0):X}":<8}0x{pt["state"]:X}')
    return '\n'.join(out)


def psec_entries(cfg, name):
    """ポートの安全なMAC：[(mac, vlan, 'SecureConfigured' / 'SecureSticky' / 'SecureDynamic')]"""
    p = port_view(cfg, name)
    vlan = p['access_vlan']
    out = [(parse_mac(m['mac']), vlan, 'SecureSticky' if m.get('sticky') else 'SecureConfigured') for m in p['psec']['macs']]
    out += [(m, vlan, 'SecureDynamic') for m in psec_state().get(name, {}).get('dynamic', [])]
    return out


def psec_ports(cfg):
    return [n for n in all_ports(cfg) if n.startswith('eth') and port_view(cfg, n)['psec']['enabled']]


def show_port_security(cfg):
    out = ['Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
           '                (Count)       (Count)          (Count)',
           '---------------------------------------------------------------------------']
    state = psec_state()
    for n in psec_ports(cfg):
        ps = port_view(cfg, n)['psec']
        out.append(f'{n:>11}{ps["max"]:>15}{len(psec_entries(cfg, n)):>13}{state.get(n, {}).get("violations", 0):>19}'
                   f'{ps["violation"].capitalize():>17}')
    total = sum(len(psec_entries(cfg, n)) for n in psec_ports(cfg))
    out += ['---------------------------------------------------------------------------',
            f'Total Addresses in System (excluding one mac per port)     : {max(0, total - len(psec_ports(cfg)))}',
            'Max Addresses limit in System (excluding one mac per port) : 4096']
    return '\n'.join(out)


def show_port_security_interface(cfg, name):
    p = port_view(cfg, name)
    ps = p['psec']
    st = psec_state().get(name, {})
    entries = psec_entries(cfg, name)
    status = link_status(name, p)
    port_status_text = ('Secure-shutdown' if status == 'err-disabled' else 'Secure-up' if status == 'connected' else 'Secure-down') \
        if ps['enabled'] else 'Secure-down'
    last = st.get('last', '')
    last_text = f'{cisco_mac(last.rsplit(":", 1)[0])}:{last.rsplit(":", 1)[1]}' if last else '0000.0000.0000:0'
    return '\n'.join([
        f'Port Security              : {"Enabled" if ps["enabled"] else "Disabled"}',
        f'Port Status                : {port_status_text}',
        f'Violation Mode             : {ps["violation"].capitalize()}',
        'Aging Time                 : 0 mins', 'Aging Type                 : Absolute',
        'SecureStatic Address Aging : Disabled',
        f'Maximum MAC Addresses      : {ps["max"]}',
        f'Total MAC Addresses        : {len(entries)}',
        f'Configured MAC Addresses   : {sum(1 for e in entries if e[2] == "SecureConfigured")}',
        f'Sticky MAC Addresses       : {sum(1 for e in entries if e[2] == "SecureSticky")}',
        f'Last Source Address:Vlan   : {last_text}',
        f'Security Violation Count   : {st.get("violations", 0)}'])


def show_port_security_address(cfg):
    out = ['               Secure Mac Address Table', '-' * 77,
           f'{"Vlan":<8}{"Mac Address":<18}{"Type":<30}{"Ports":<8}Remaining Age', f'{"":64}(mins)',
           f'{"----":<8}{"-----------":<18}{"----":<30}{"-----":<8}-------------']
    total = 0
    for n in psec_ports(cfg):
        for mac, vlan, kind in psec_entries(cfg, n):
            out.append(f'{vlan:>4}    {cisco_mac(mac):<18}{kind:<30}{n:<8}    -')
            total += 1
    out += ['-' * 77, f'Total Addresses in System (excluding one mac per port)     : {max(0, total - len(psec_ports(cfg)))}',
            'Max Addresses limit in System (excluding one mac per port) : 4096']
    return '\n'.join(out)


def show_logging(cfg):
    lines = read_log_lines()
    console = cfg.get('logging', {}).get('console', True)
    head = ['Syslog logging: enabled', f'    Console logging: {"level debugging" if console else "disabled"}',
            f'    Buffer logging:  level debugging, {len(lines)} messages logged', '', 'Log Buffer:']
    return '\n'.join(head + lines[-200:])


def show_running(cfg):
    lines = ['Building configuration...', '', 'Current configuration:', '!', f'hostname {cfg["hostname"]}', '!']
    lines += running_auth_lines(cfg)
    for vid in sorted(cfg['vlans'], key=int):
        if vid == '1':
            continue
        lines.append(f'vlan {vid}')
        name = cfg['vlans'][vid]
        if name and name != f'VLAN{int(vid):04d}':
            lines.append(f' name {name}')
        lines.append('!')
    lines += running_stp_lines(cfg)
    lines += running_global_lines(cfg)
    for name in all_ports(cfg):
        p = port_view(cfg, name)
        lines.append(f'interface {"Port-channel" + name[2:] if name.startswith("po") else name}')
        cg = cfg['interfaces'].get(name, {}).get('channel_group')
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
        ps = p['psec']
        if ps['enabled']:
            lines.append(' switchport port-security')
        if ps['max'] != 1:
            lines.append(f' switchport port-security maximum {ps["max"]}')
        if ps['violation'] != 'shutdown':
            lines.append(f' switchport port-security violation {ps["violation"]}')
        if ps['sticky']:
            lines.append(' switchport port-security mac-address sticky')
        for m in ps['macs']:
            lines.append(f' switchport port-security mac-address {"sticky " if m.get("sticky") else ""}{cisco_mac(m["mac"])}')
        if not p['lldp_tx']:
            lines.append(' no lldp transmit')
        if not p['lldp_rx']:
            lines.append(' no lldp receive')
        if not p['cdp']:
            lines.append(' no cdp enable')
        if cg:
            lines.append(f' channel-group {cg["id"]} mode {cg["mode"]}')
        if p['shutdown']:
            lines.append(' shutdown')
        lines.append('!')
    lines += running_svi_lines(cfg)
    lines += running_line_lines(cfg)
    lines.append('end')
    return '\n'.join(lines)


def running_auth_lines(cfg):
    a = auth_view(cfg)
    lines = []
    if a['encryption']:
        lines.append('service password-encryption')
    if a['enable_secret']:
        lines.append(f'enable secret 9 {a["enable_secret"]}')
    if a['enable_password']:
        lines.append(f'enable password {show_password(cfg, a["enable_password"])}')
    return lines + ['!'] if lines else []


def running_line_lines(cfg):
    a = auth_view(cfg)
    lines = ['line con 0']
    if a['console_password']:
        lines.append(f' password {show_password(cfg, a["console_password"])}')
    if a['logging_sync']:
        lines.append(' logging synchronous')
    if a['console_login']:
        lines.append(' login')
    return lines + ['!'] if len(lines) > 1 else []


def running_svi_lines(cfg):
    lines = []
    for vid in svi_ids(cfg):
        v = svi_view(cfg, vid)
        lines.append(f'interface Vlan{vid}')
        if v['description']:
            lines.append(f' description {v["description"]}')
        if v['address']:
            ip, prefix = v['address'].split('/')
            lines.append(f' ip address {ip} {prefix_to_mask(int(prefix))}')
        else:
            lines.append(' no ip address')
        if v['shutdown']:
            lines.append(' shutdown')
        lines.append('!')
    if cfg.get('default_gateway'):
        lines += [f'ip default-gateway {cfg["default_gateway"]}', '!']
    return lines


def running_global_lines(cfg):
    """MACテーブル・ログ等のグローバル設定（2026-10-14〜）"""
    lines = []
    m = mac_view(cfg)
    if m['aging'] != MAC_AGING_DEFAULT:
        lines.append(f'mac address-table aging-time {m["aging"]}')
    for e in m['static']:
        lines.append(f'mac address-table static {cisco_mac(e["mac"])} vlan {e["vlan"]} interface {e["iface"]}')
    if not cfg.get('logging', {}).get('console', True):
        lines.append('no logging console')
    g = discovery_view(cfg)
    if not g['cdp']:
        lines.append('no cdp run')
    if g['lldp']:
        lines.append('lldp run')
    if lines:
        lines.append('!')
    return lines


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
        out.append(f'{disp(name):<20}{role:<5}{STATE_SHORT.get(d.get("state"), "BLK"):<4}{str(cost):<10}'
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
            out += ['', f'MST{i}', '  Spanning tree enabled protocol mstp',
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
        ports = [disp(n) for n in bridge_ports(cfg) if port_view(cfg, n)['mode'] == 'access' and port_view(cfg, n)['access_vlan'] == int(vid)]
        out.append(f'{vid:<5}{cfg["vlans"][vid]:<33}{"active":<10}{", ".join(ports)}')
    return '\n'.join(out)


def show_interfaces_status(cfg):
    out = [f'{"Port":<9}{"Name":<19}{"Status":<13}Vlan']
    for name in all_ports(cfg):
        p = port_view(cfg, name)
        vlan = 'trunk' if p['mode'] == 'trunk' else str(p['access_vlan'])
        if member_of(cfg, name):
            vlan = 'trunk' if port_view(cfg, f'po{member_of(cfg, name)}')['mode'] == 'trunk' else str(port_view(cfg, f'po{member_of(cfg, name)}')['access_vlan'])
        out.append(f'{disp(name):<9}{p["description"][:18]:<19}{link_status(name, p):<13}{vlan}')
    return '\n'.join(out)


def show_interfaces_trunk(cfg):
    trunks = [n for n in bridge_ports(cfg) if port_view(cfg, n)['mode'] == 'trunk']
    if not trunks:
        return ''
    out = [f'{"Port":<9}{"Mode":<13}{"Status":<13}Native vlan']
    for n in trunks:
        p = port_view(cfg, n)
        out.append(f'{disp(n):<9}{"on":<13}{"trunking" if link_status(n, p) == "connected" else link_status(n, p):<13}{p["native"]}')
    out += ['', f'{"Port":<9}Vlans allowed on trunk']
    for n in trunks:
        p = port_view(cfg, n)
        out.append(f'{disp(n):<9}{"1-4094" if p["allowed"] == "all" else format_vlan_list(p["allowed"])}')
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# コマンドの文法（Cisco風）。表示メッセージは英語（2026-10-14：端末で日本語が文字化けしたため）
# ---------------------------------------------------------------------------
# 文法は「キーワード／引数」の木。各キーワードは一意に決まる範囲で省略でき（conf t、int e1、sw mo acc）、
# 完全一致のキーワードは前方一致より優先する。キーワードに一致しない時だけ引数として解釈する。
#   <vlan>  1-4094   <vlans> VLANリスト(1,10-20)   <iface> eth1（e1 / eth 1 / Ethernet1も可）
#   <ifaces> eth1-3,eth5   <word> 1語   <line> 行の残り全部

IFACE_WORD = re.compile(r'e(t(h(e(r(n(e(t)?)?)?)?)?)?)?', re.I)


PO_WORD = re.compile(r'po(r(t(-(c(h(a(n(n(e(l)?)?)?)?)?)?)?)?)?)?', re.I)


def norm_iface(tok):
    m = re.fullmatch(r'e(?:t(?:h(?:e(?:r(?:n(?:e(?:t)?)?)?)?)?)?)?(\d+)', tok, re.I)
    if m and int(m.group(1)) >= 1:
        return f'eth{int(m.group(1))}'
    m = re.fullmatch(r'po(?:r(?:t(?:-(?:c(?:h(?:a(?:n(?:n(?:e(?:l)?)?)?)?)?)?)?)?)?)?(\d+)', tok, re.I)
    if m and 1 <= int(m.group(1)) <= 64:
        return f'po{int(m.group(1))}'
    return None


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
    # Ciscoと同じ `interface range eth1 - 3 , eth5` も通す（rangeの行でだけ-と,の前後の空白を詰める。
    # descriptionの「a - b」等は変えない）
    m = re.match(r'(\s*int\S*\s+ran\S*\s+)(.*)$', line, re.I)
    if m:
        line = m.group(1) + re.sub(r'([a-z])\s+(\d)', r'\1\2', re.sub(r'\s*([-,])\s*', r'\1', m.group(2)), flags=re.I)
    raw = line.split()
    tokens = []
    i = 0
    while i < len(raw):
        tok = raw[i]
        if (IFACE_WORD.fullmatch(tok) or PO_WORD.fullmatch(tok)) and i + 1 < len(raw) and re.match(r'\d', raw[i + 1]):
            tok += raw[i + 1]
            i += 1
        m = re.fullmatch(r'(vlan)(\d+)', tok, re.I)
        if m and tokens and tokens[-1].lower().startswith('int'):  # int vlan10 → int vlan 10
            tokens += [m.group(1), m.group(2)]
            i += 1
            continue
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
    '<mac>': lambda t: parse_mac(t) is not None,
    '<ip>': is_ipv4,
    '<mask>': lambda t: mask_to_prefix(t) is not None,
    '<count>': lambda t: t.isdigit() and 1 <= int(t) <= 2147483647,
    '<size>': lambda t: t.isdigit() and 36 <= int(t) <= 18024,
    '<pw>': lambda t: True,
    '<line0>': lambda t: t == '0',
    '<group>': lambda t: t.isdigit() and 1 <= int(t) <= 64,
    '<psmax>': lambda t: t.isdigit() and 1 <= int(t) <= 8192,
    '<aging>': lambda t: t.isdigit() and 10 <= int(t) <= 1000000,
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
    '<mac>': ('H.H.H', '48 bit mac address'),
    '<ip>': ('A.B.C.D', 'IP address'),
    '<mask>': ('A.B.C.D', 'IP subnet mask'),
    '<count>': ('<1-2147483647>', 'Number of pings'),
    '<size>': ('<36-18024>', 'Datagram size'),
    '<pw>': ('LINE', 'The password'),
    '<line0>': ('<0-0>', 'First Line number'),
    '<group>': ('<1-64>', 'Channel group number'),
    '<psmax>': ('<1-8192>', 'Maximum addresses'),
    '<aging>': ('<10-1000000>', 'Aging time in seconds'),
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
    'counters': 'Show interface counters', 'clear': 'Reset functions', 'dynamic': 'dynamic entry type',
    'static': 'static keyword', 'address': 'address keyword', 'count': 'Count of MAC addresses',
    'aging-time': 'Set MAC address table entry maximum age', 'logging': 'Modify message logging facilities',
    'console': 'Set console logging parameters', 'ip': 'Global IP configuration subcommands',
    'default-gateway': 'Specify default gateway (if not routing IP)', 'ping': 'Send echo messages',
    'repeat': 'specify repeat count', 'size': 'specify datagram size', 'secret': 'Assign the privileged level secret',
    'password': 'Assign the privileged level password', 'line': 'Configure a terminal line', 'con': 'Primary terminal line',
    'login': 'Enable password checking', 'service': 'Modify use of network based services',
    'password-encryption': 'Encrypt system passwords', 'disable': 'Turn off privileged commands',
    'synchronous': 'Synchronized message output',
    'lldp': 'Global LLDP configuration subcommands', 'cdp': 'Global CDP configuration subcommands',
    'run': 'Enable protocol', 'neighbors': 'neighbor entries', 'detail': 'Show detailed information',
    'transmit': 'Enable LLDP transmission on interface', 'receive': 'Enable LLDP reception on interface',
    'etherchannel': 'EtherChannel information', 'summary': 'One-line summary per channel-group',
    'lacp': 'LACP information', 'neighbor': 'LACP neighbor information', 'channel-group': 'Etherchannel / port bundling configuration',
    'active': 'Enable LACP unconditionally', 'passive': 'Enable LACP only if a LACP device is detected',
    'on': 'Enable Etherchannel only', 'desirable': 'Enable PAgP unconditionally', 'auto': 'Enable PAgP only if a PAgP device is detected',
    'port-security': 'Security related command', 'maximum': 'Max secure addresses', 'violation': 'Security violation mode',
    'protect': 'Security violation protect mode', 'restrict': 'Security violation restrict mode',
    'mac-address': 'Secure mac address', 'sticky': 'Configure dynamic secure addresses as sticky',
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


SUB_MODES = ('interface', 'vlan', 'mst', 'svi', 'line')


def filter_output(lines, kind, pattern):
    if kind == 'include':
        return [x for x in lines if pattern.search(x)]
    if kind == 'exclude':
        return [x for x in lines if not pattern.search(x)]
    if kind == 'begin':
        for i, x in enumerate(lines):
            if pattern.search(x):
                return lines[i:]
        return []
    # section：一致した行と、その下の字下げされた行
    out, inside = [], False
    for x in lines:
        if x and not x[0].isspace():
            inside = bool(pattern.search(x))
        if inside or (x and not x[0].isspace() and pattern.search(x)):
            out.append(x)
    return out


class Cli:
    def __init__(self):
        self.mode = 'exec'
        self.waiting_input = False
        self.ifaces = []  # interfaceモードの対象
        self.vlan = None  # vlanモードの対象
        self.svi = None  # interface vlan N のN
        self.trees = {mode: build_tree(entries) for mode, entries in self.build_grammar().items()}

    # ---- 文法 ----
    def build_grammar(self):
        p = lambda f: (lambda a: print(f(self.cfg())))  # noqa: E731
        show = [
            (['show', 'running-config'], p(show_running), 'Current operating configuration'),
            (['show', 'startup-config'], self.show_startup, 'Contents of startup configuration'),
            (['show', 'vlan'], p(show_vlan_brief), 'VTP VLAN status'),
            (['show', 'vlan', 'brief'], p(show_vlan_brief), 'VTP all VLAN status in brief'),
            (['show', 'interfaces'], p(show_interfaces_all), 'Interface status and configuration'),
            (['show', 'interfaces', '<iface>'], lambda a: print(show_interface_detail(self.cfg(), norm_iface(a[0]))), 'Interface'),
            (['show', 'interfaces', 'counters'], p(show_interfaces_counters), 'Show interface counters'),
            (['show', 'logging'], p(show_logging), 'Show the contents of logging buffers'),
            (['show', 'ip', 'interface', 'brief'], p(show_ip_interface_brief), 'Brief summary of IP status and configuration'),
            (['show', 'etherchannel', 'summary'], p(show_etherchannel_summary), 'One-line summary per channel-group'),
            (['show', 'port-security'], p(show_port_security), 'Show secure port information'),
            (['show', 'port-security', 'interface', '<iface>'], lambda a: print(show_port_security_interface(self.cfg(), norm_iface(a[0]))), 'Show secure interface'),
            (['show', 'port-security', 'address'], p(show_port_security_address), 'Show secure address'),
            (['show', 'lacp', 'neighbor'], p(show_lacp_neighbor), 'LACP neighbor information'),
            (['show', 'lldp'], p(show_lldp), 'LLDP information'),
            (['show', 'lldp', 'neighbors'], p(show_lldp_neighbors), 'LLDP neighbor entries'),
            (['show', 'lldp', 'neighbors', 'detail'], lambda a: print(show_lldp_neighbors(self.cfg(), True)), 'Show detailed information'),
            (['show', 'cdp'], p(show_cdp), 'CDP information'),
            (['show', 'cdp', 'neighbors'], p(show_cdp_neighbors), 'CDP neighbor entries'),
            (['show', 'cdp', 'neighbors', 'detail'], lambda a: print(show_cdp_neighbors(self.cfg(), True)), 'Show detailed information'),
            (['show', 'interfaces', 'vlan', '<vlan>'], lambda a: print(show_svi_detail(self.cfg(), int(a[0]))), 'VLAN interface'),
            (['show', 'interfaces', 'status'], p(show_interfaces_status), 'Show interface line status'),
            (['show', 'interfaces', 'trunk'], p(show_interfaces_trunk), 'Show interface trunk information'),
            *self.mac_show_entries(),
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
                (['ping', '<ip>'], self.do_ping, 'Send echo messages'),
                (['ping', '<ip>', 'repeat', '<count>'], self.do_ping, 'specify repeat count'),
                (['ping', '<ip>', 'size', '<size>'], lambda a: self.do_ping([a[0]], size=int(a[1])), 'specify datagram size'),
                (['disable'], self.do_disable, 'Turn off privileged commands'),
                (['clear', 'counters'], self.do_clear_counters, 'Clear counters on all interfaces'),
                (['clear', 'counters', '<iface>'], self.do_clear_counters, 'Clear counters on one interface'),
                (['clear', 'mac', 'address-table', 'dynamic'], lambda a: clear_mac(), 'Clear all dynamic entries'),
                (['clear', 'mac', 'address-table', 'dynamic', 'address', '<mac>'], lambda a: clear_mac(address=parse_mac(a[0])), '48 bit mac address'),
                (['clear', 'mac', 'address-table', 'dynamic', 'interface', '<iface>'], lambda a: clear_mac(iface=norm_iface(a[0])), 'interface'),
                (['clear', 'mac', 'address-table', 'dynamic', 'vlan', '<vlan>'], lambda a: clear_mac(vlan=int(a[0])), 'VLAN'),
                (['clear', 'logging'], self.do_clear_logging, 'Clear logging buffer'),
                (['clear', 'port-security', 'all'], lambda a: self.do_clear_psec(('dynamic', 'sticky', 'configured')), 'Clear all secure addresses'),
                (['clear', 'port-security', 'dynamic'], lambda a: self.do_clear_psec(('dynamic',)), 'Clear secure dynamic addresses'),
                (['clear', 'port-security', 'sticky'], lambda a: self.do_clear_psec(('sticky',)), 'Clear secure sticky addresses'),
                (['clear', 'port-security', 'dynamic', 'interface', '<iface>'], lambda a: self.do_clear_psec(('dynamic',), norm_iface(a[0])), 'interface'),
                (['clear', 'port-security', 'sticky', 'interface', '<iface>'], lambda a: self.do_clear_psec(('sticky',), norm_iface(a[0])), 'interface'),
                (['exit'], self.do_logout, 'Exit from the EXEC'),
                (['quit'], self.do_logout, 'Exit from the EXEC'),
            ],
            'user': [e for e in show if e[0][1] not in ('running-config', 'startup-config')] + [
                (['enable'], self.do_enable, 'Turn on privileged commands'),
                (['ping', '<ip>'], self.do_ping, 'Send echo messages'),
                (['exit'], self.do_logout, 'Exit from the EXEC'),
                (['quit'], self.do_logout, 'Exit from the EXEC'),
                (['logout'], self.do_logout, 'Exit from the EXEC'),
            ],
            'svi': common_cfg + [
                (['ip', 'address', '<ip>', '<mask>'], self.do_svi_address, 'Set the IP address of an interface'),
                (['no', 'ip', 'address'], lambda a: self.set_svi(address=None), 'Remove the IP address'),
                (['shutdown'], lambda a: self.set_svi(shutdown=None), 'Shutdown the selected interface'),
                (['no', 'shutdown'], lambda a: self.set_svi(shutdown=False), 'Enable the selected interface'),
                (['description', '<line>'], lambda a: self.set_svi(description=a[0]), 'Interface specific description'),
                (['no', 'description'], lambda a: self.set_svi(description=None), 'Remove the description'),
            ],
            'line': common_cfg + [
                (['password', '<pw>'], lambda a: self.set_auth(console_password=a[0]), 'Set a password'),
                (['password', '0', '<pw>'], lambda a: self.set_auth(console_password=a[0]), 'Specifies an UNENCRYPTED password will follow'),
                (['password', '7', '<pw>'], self.do_line_password7, 'Specifies a HIDDEN password will follow'),
                (['no', 'password'], lambda a: self.set_auth(console_password=None), 'Remove the password'),
                (['login'], lambda a: self.set_auth(console_login=True), 'Enable password checking'),
                (['no', 'login'], lambda a: self.set_auth(console_login=None), 'Disable password checking'),
                (['logging', 'synchronous'], lambda a: self.set_auth(logging_sync=True), 'Synchronized message output'),
                (['no', 'logging', 'synchronous'], lambda a: self.set_auth(logging_sync=None), 'Disable synchronized message output'),
            ],
            'config': common_cfg + [
                (['hostname', '<word>'], self.do_hostname, "Set system's network name"),
                (['interface', 'vlan', '<vlan>'], self.do_interface_vlan, 'Catalyst Vlans'),
                (['lldp', 'run'], lambda a: self.set_discovery(lldp=True), 'Enable LLDP'),
                (['no', 'lldp', 'run'], lambda a: self.set_discovery(lldp=None), 'Disable LLDP'),
                (['cdp', 'run'], lambda a: self.set_discovery(cdp=None), 'Enable CDP'),
                (['no', 'cdp', 'run'], lambda a: self.set_discovery(cdp=False), 'Disable CDP'),
                (['no', 'interface', 'vlan', '<vlan>'], self.do_no_interface_vlan, 'Delete a VLAN interface'),
                (['ip', 'default-gateway', '<ip>'], lambda a: self.modify(lambda c: c.__setitem__('default_gateway', a[0])),
                 'Specify default gateway (if not routing IP)'),
                (['no', 'ip', 'default-gateway'], lambda a: self.modify(lambda c: c.pop('default_gateway', None)), 'Remove the default gateway'),
                (['enable', 'secret', '<pw>'], lambda a: self.set_auth(enable_secret=type9_hash(a[0])), 'Assign the privileged level secret'),
                (['enable', 'secret', '0', '<pw>'], lambda a: self.set_auth(enable_secret=type9_hash(a[0])), 'Specifies an UNENCRYPTED secret will follow'),
                (['enable', 'secret', '9', '<pw>'], self.do_enable_secret9, 'Specifies a SCRYPT hashed secret will follow'),
                (['no', 'enable', 'secret'], lambda a: self.set_auth(enable_secret=None), 'Remove the enable secret'),
                (['enable', 'password', '<pw>'], lambda a: self.set_auth(enable_password=a[0]), 'Assign the privileged level password'),
                (['enable', 'password', '7', '<pw>'], self.do_enable_password7, 'Specifies a HIDDEN password will follow'),
                (['no', 'enable', 'password'], lambda a: self.set_auth(enable_password=None), 'Remove the enable password'),
                (['service', 'password-encryption'], lambda a: self.set_auth(encryption=True), 'Encrypt system passwords'),
                (['no', 'service', 'password-encryption'], lambda a: self.set_auth(encryption=None), 'Do not encrypt system passwords'),
                (['line', 'con', '<line0>'], lambda a: self.enter_mode('line'), 'Primary terminal line'),
                (['line', 'console', '<line0>'], lambda a: self.enter_mode('line'), 'Primary terminal line'),
                (['mac', 'address-table', 'aging-time', '<aging>'], lambda a: self.set_mac(aging=int(a[0])), 'Set MAC address table entry maximum age'),
                (['no', 'mac', 'address-table', 'aging-time'], lambda a: self.set_mac(aging=None), 'Reset the aging time to 300 seconds'),
                (['mac', 'address-table', 'static', '<mac>', 'vlan', '<vlan>', 'interface', '<iface>'], self.do_mac_static, 'Configure a static MAC address'),
                (['no', 'mac', 'address-table', 'static', '<mac>', 'vlan', '<vlan>'], self.do_no_mac_static, 'Remove a static MAC address'),
                (['no', 'mac', 'address-table', 'static', '<mac>', 'vlan', '<vlan>', 'interface', '<iface>'], self.do_no_mac_static, 'Remove a static MAC address'),
                (['logging', 'console'], lambda a: self.set_logging(console=None), 'Set console logging parameters'),
                (['no', 'logging', 'console'], lambda a: self.set_logging(console=False), 'Disable console logging'),
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
                (['switchport', 'port-security'], lambda a: self.set_psec(enabled=True), 'Security related command'),
                (['no', 'switchport', 'port-security'], lambda a: self.set_psec(enabled=None), 'Disable port security'),
                (['switchport', 'port-security', 'maximum', '<psmax>'], lambda a: self.set_psec(max=None if int(a[0]) == 1 else int(a[0])), 'Max secure addresses'),
                (['no', 'switchport', 'port-security', 'maximum'], lambda a: self.set_psec(max=None), 'Reset the maximum to 1'),
                (['switchport', 'port-security', 'violation', 'protect'], lambda a: self.set_psec(violation='protect'), 'Security violation protect mode'),
                (['switchport', 'port-security', 'violation', 'restrict'], lambda a: self.set_psec(violation='restrict'), 'Security violation restrict mode'),
                (['switchport', 'port-security', 'violation', 'shutdown'], lambda a: self.set_psec(violation=None), 'Security violation shutdown mode'),
                (['no', 'switchport', 'port-security', 'violation'], lambda a: self.set_psec(violation=None), 'Reset the violation mode to shutdown'),
                (['switchport', 'port-security', 'mac-address', 'sticky'], lambda a: self.set_psec(sticky=True), 'Configure dynamic secure addresses as sticky'),
                (['no', 'switchport', 'port-security', 'mac-address', 'sticky'], self.do_no_psec_sticky, 'Disable sticky learning'),
                (['switchport', 'port-security', 'mac-address', '<mac>'], lambda a: self.do_psec_mac(a[0], False), '48 bit mac address'),
                (['switchport', 'port-security', 'mac-address', 'sticky', '<mac>'], lambda a: self.do_psec_mac(a[0], True), '48 bit mac address'),
                (['no', 'switchport', 'port-security', 'mac-address', '<mac>'], lambda a: self.do_no_psec_mac(a[0]), 'Remove a secure address'),
                (['no', 'switchport', 'port-security', 'mac-address', 'sticky', '<mac>'], lambda a: self.do_no_psec_mac(a[0]), 'Remove a secure address'),
                (['channel-group', '<group>', 'mode', 'active'], lambda a: self.do_channel_group(a[0], 'active'), 'Enable LACP unconditionally'),
                (['channel-group', '<group>', 'mode', 'passive'], lambda a: self.do_channel_group(a[0], 'passive'), 'Enable LACP only if a LACP device is detected'),
                (['channel-group', '<group>', 'mode', 'on'], lambda a: self.do_channel_group(a[0], 'on'), 'Enable Etherchannel only'),
                (['channel-group', '<group>', 'mode', 'desirable'], lambda a: self.do_channel_group(a[0], 'desirable'), 'Enable PAgP unconditionally'),
                (['channel-group', '<group>', 'mode', 'auto'], lambda a: self.do_channel_group(a[0], 'auto'), 'Enable PAgP only if a PAgP device is detected'),
                (['no', 'channel-group'], lambda a: self.set_port(channel_group=None), 'Remove the interface from its channel group'),
                (['lldp', 'transmit'], lambda a: self.set_port(lldp_tx=None), 'Enable LLDP transmission on interface'),
                (['no', 'lldp', 'transmit'], lambda a: self.set_port(lldp_tx=False), 'Disable LLDP transmission on interface'),
                (['lldp', 'receive'], lambda a: self.set_port(lldp_rx=None), 'Enable LLDP reception on interface'),
                (['no', 'lldp', 'receive'], lambda a: self.set_port(lldp_rx=False), 'Disable LLDP reception on interface'),
                (['cdp', 'enable'], lambda a: self.set_port(cdp=None), 'Enable CDP on interface'),
                (['no', 'cdp', 'enable'], lambda a: self.set_port(cdp=False), 'Disable CDP on interface'),
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
            if self.mode not in SUB_MODES:
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
        if changes.get('shutdown'):
            # err-disabledのポートは shutdown で戻す（Ciscoと同じ）。shutdown → no shutdown を続けて打つと
            # エージェントがshutdownの状態を見る前に戻るので、ここで解除して、エージェントに知らせる
            errdisabled = load_errdisabled()
            cleared = [n for n in self.ifaces if n in errdisabled]
            if cleared:
                for n in cleared:
                    errdisabled.pop(n)
                save_errdisabled(errdisabled)
                with open(RECOVERING, 'a') as f:
                    f.write(''.join(f'{n}\n' for n in cleared))

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

    # ---- SVI・パスワード・ping（2026-10-14〜） ----
    def enter_mode(self, mode):
        self.mode = mode

    def do_interface_vlan(self, a):
        vid = int(a[0])
        self.svi = vid
        self.modify(lambda cfg: cfg.setdefault('svi', {}).setdefault(str(vid), {}))
        self.mode = 'svi'

    def do_no_interface_vlan(self, a):
        def fn(cfg):
            cfg.get('svi', {}).pop(str(int(a[0])), None)
            if not cfg.get('svi'):
                cfg.pop('svi', None)
        self.modify(fn)

    def set_svi(self, **changes):
        def fn(cfg):
            v = cfg.setdefault('svi', {}).setdefault(str(self.svi), {})
            for k, val in changes.items():
                if val is None:
                    v.pop(k, None)
                else:
                    v[k] = val
        self.modify(fn)

    def do_svi_address(self, a):
        prefix = mask_to_prefix(a[1])
        if prefix is None or prefix > 30:
            print('% Bad mask /' + str(prefix) + ' for address ' + a[0])
            return
        self.set_svi(address=f'{a[0]}/{prefix}')

    def set_auth(self, **changes):
        def fn(cfg):
            au = cfg.setdefault('auth', {})
            for k, v in changes.items():
                if v is None:
                    au.pop(k, None)
                else:
                    au[k] = v
            if not au:
                cfg.pop('auth')
        self.modify(fn)

    def do_enable_secret9(self, a):
        if not re.fullmatch(r'\$9\$[./0-9A-Za-z]{14}\$[./0-9A-Za-z]{43}', a[0]):
            print('% Invalid encrypted secret')
            return
        self.set_auth(enable_secret=a[0])

    def do_enable_password7(self, a):
        plain = type7_decode(a[0])
        if plain is None:
            print('% Invalid encrypted password')
            return
        self.set_auth(enable_password=plain)

    def do_line_password7(self, a):
        plain = type7_decode(a[0])
        if plain is None:
            print('% Invalid encrypted password')
            return
        self.set_auth(console_password=plain)

    def check_password(self, prompt, ok, fail_message):
        """Ciscoと同じく3回まで聞く"""
        import getpass
        for _ in range(3):
            try:
                if ok(getpass.getpass(prompt)):
                    return True
            except (EOFError, KeyboardInterrupt):
                print()
                return False
        print(fail_message)
        return False

    def do_enable(self, a):
        au = auth_view(self.cfg())
        if au['enable_secret']:
            ok = lambda pw: type9_check(pw, au['enable_secret'])  # noqa: E731
        elif au['enable_password']:
            ok = lambda pw: pw == au['enable_password']  # noqa: E731
        else:
            self.mode = 'exec'
            return
        if self.check_password('Password: ', ok, '% Bad secrets'):
            self.mode = 'exec'

    def do_disable(self, a):
        self.mode = 'user'

    def login(self):
        """line con 0 の login と password があれば、最初にパスワードを聞く。enable secret/passwordがあれば
        ユーザーモード（>）から始める（無ければ特権モードから。演習で毎回enableを打たなくて済むように）"""
        au = auth_view(self.cfg())
        if au['console_login']:
            if not au['console_password']:
                print('Password required, but none set')
                time.sleep(2)
                raise EOFError
            print('\nUser Access Verification\n')
            if not self.check_password('Password: ', lambda pw: pw == au['console_password'], '% Bad passwords'):
                time.sleep(1)
                raise EOFError
        self.mode = 'user' if au['enable_secret'] or au['enable_password'] else 'exec'

    def do_ping(self, a, size=100):
        """Ciscoと同じ見た目のping（1回ずつbusyboxのpingを打つ）。管理ネットワーク（eth0）宛ては通さない"""
        target = a[0]
        count = int(a[1]) if len(a) > 1 else 5
        print('Type escape sequence to abort.')
        print(f'Sending {count}, {size}-byte ICMP Echos to {target}, timeout is 2 seconds:')
        route = sh('ip', '-j', 'route', 'get', target)
        try:
            dev = (json.loads(route.stdout or '[]') or [{}])[0].get('dev')
        except ValueError:
            dev = None
        times = []
        for i in range(count):
            if dev is None or dev == 'eth0':
                ok = False
                time.sleep(0.2)
            else:
                r = sh('ping', '-c', '1', '-W', '2', '-s', str(max(size - 28, 8)), target)
                m = re.search(r'time=([\d.]+) ms', r.stdout)
                ok = r.returncode == 0 and m is not None
                if ok:
                    times.append(float(m.group(1)))
            sys.stdout.write('!' if ok else '.')
            if (i + 1) % 70 == 0:
                sys.stdout.write('\n')
            sys.stdout.flush()
        print()
        line = f'Success rate is {len(times) * 100 // count} percent ({len(times)}/{count})'
        if times:
            ms = [max(1, round(t)) for t in times]
            line += f', round-trip min/avg/max = {min(ms)}/{round(sum(ms) / len(ms))}/{max(ms)} ms'
        print(line)

    def mac_show_entries(self):
        """show mac address-table [dynamic|static] [address M | interface X | vlan N] / count / aging-time"""
        entries = []
        for base in (['show', 'mac', 'address-table'], ['show', 'mac-address-table']):
            for kind in (None, 'dynamic', 'static'):
                head = base + ([kind] if kind else [])
                k = kind.upper() if kind else None
                entries += [
                    (head, lambda a, k=k: print(show_mac(self.cfg(), kind=k)), 'MAC forwarding table'),
                    (head + ['address', '<mac>'], lambda a, k=k: print(show_mac(self.cfg(), kind=k, address=parse_mac(a[0]))), 'address'),
                    (head + ['interface', '<iface>'], lambda a, k=k: print(show_mac(self.cfg(), kind=k, iface=norm_iface(a[0]))), 'interface'),
                    (head + ['vlan', '<vlan>'], lambda a, k=k: print(show_mac(self.cfg(), kind=k, vlan=int(a[0]))), 'VLAN'),
                ]
            entries += [
                (base + ['count'], lambda a: print(show_mac(self.cfg(), count=True)), 'Count of MAC addresses'),
                (base + ['aging-time'], lambda a: print(f'Global Aging Time: {mac_view(self.cfg())["aging"]:>4}'), 'aging time'),
            ]
        return entries

    def do_clear_counters(self, a):
        names = [norm_iface(a[0])] if a else all_ports(self.cfg())
        clear_counters(names)
        log_event('%CLEAR-5-COUNTERS: Clear counter on ' + (f'interface {disp(names[0])}' if a else 'all interfaces') + ' by console')

    def do_clear_logging(self, a):
        for path in (LOG_FILE, LOG_OLD):
            try:
                os.remove(path)
            except OSError:
                pass

    def set_mac(self, **changes):
        def fn(cfg):
            m = cfg.setdefault('mac', {})
            for k, v in changes.items():
                if v is None or (k == 'aging' and v == MAC_AGING_DEFAULT):
                    m.pop(k, None)
                else:
                    m[k] = v
            if not m:
                cfg.pop('mac')
        self.modify(fn)

    def do_mac_static(self, a):
        mac, vlan, iface = parse_mac(a[0]), int(a[1]), norm_iface(a[2])
        static = [e for e in mac_view(self.cfg())['static'] if not (e['mac'] == mac and e['vlan'] == vlan)]
        self.set_mac(static=static + [{'mac': mac, 'vlan': vlan, 'iface': iface}])

    def do_no_mac_static(self, a):
        mac, vlan = parse_mac(a[0]), int(a[1])
        static = [e for e in mac_view(self.cfg())['static'] if not (e['mac'] == mac and e['vlan'] == vlan)]
        self.set_mac(static=static or None)

    # ---- ポートセキュリティ ----
    def psec_check(self):
        cfg = self.cfg()
        for name in self.ifaces:
            if not name.startswith('eth') or port_view(cfg, name)['mode'] != 'access':
                print(f'Command rejected: {disp(name)} is not an access port. (use switchport mode access)')
                return False
        return True

    def set_psec(self, **changes):
        if changes.get('enabled') and not self.psec_check():
            return

        def fn(cfg):
            for name in self.ifaces:
                ps = port_cfg(cfg, name).setdefault('psec', {})
                for k, v in changes.items():
                    if v is None:
                        ps.pop(k, None)
                    else:
                        ps[k] = v
                if not ps:
                    port_cfg(cfg, name).pop('psec')
        self.modify(fn)

    def do_psec_mac(self, mac_text, sticky):
        mac = parse_mac(mac_text)

        def fn(cfg):
            for name in self.ifaces:
                ps = port_cfg(cfg, name).setdefault('psec', {})
                lst = [m for m in ps.get('macs', []) if parse_mac(m['mac']) != mac]
                if len(lst) >= psec_view(ps)['max']:
                    print(f'Total secure mac-addresses on interface {name} has reached maximum limit.')
                    continue
                ps['macs'] = lst + [{'mac': mac, 'sticky': True} if sticky else {'mac': mac}]
        self.modify(fn)

    def do_no_psec_mac(self, mac_text):
        mac = parse_mac(mac_text)

        def fn(cfg):
            for name in self.ifaces:
                ps = port_cfg(cfg, name).get('psec', {})
                ps['macs'] = [m for m in ps.get('macs', []) if parse_mac(m['mac']) != mac]
                if not ps['macs']:
                    ps.pop('macs')
        self.modify(fn)

    def do_no_psec_sticky(self, a):
        """stickyをやめると、stickyで覚えたMACは消える（Ciscoでは動的な安全なMACになるが、ここでは消す）"""
        def fn(cfg):
            for name in self.ifaces:
                ps = port_cfg(cfg, name).get('psec', {})
                ps.pop('sticky', None)
                ps['macs'] = [m for m in ps.get('macs', []) if not m.get('sticky')]
                if not ps['macs']:
                    ps.pop('macs')
        self.modify(fn)

    def do_clear_psec(self, kinds, iface=None):
        cfg = self.cfg()
        targets = [iface] if iface else psec_ports(cfg)
        if 'dynamic' in kinds:
            state = psec_state()
            for n in targets:
                if n in state:
                    state[n]['dynamic'] = []
            save(PSEC_STATE, state)
        if 'sticky' in kinds or 'configured' in kinds:
            def fn(cfg):
                for n in targets:
                    ps = cfg['interfaces'].get(n, {}).get('psec')
                    if not ps:
                        continue
                    ps['macs'] = [m for m in ps.get('macs', []) if not (('sticky' in kinds and m.get('sticky')) or
                                                                         ('configured' in kinds and not m.get('sticky')))]
                    if not ps['macs']:
                        ps.pop('macs')
            self.modify(fn)

    def do_channel_group(self, group, mode):
        if mode in ('desirable', 'auto'):
            print('% PAgP (desirable/auto) is Cisco proprietary and not supported. Use LACP (active/passive) or on.')
            return
        if any(not n.startswith('eth') for n in self.ifaces):
            print('% channel-group can only be configured on physical interfaces (ethN)')
            return
        n = int(group)
        cfg = self.cfg()
        g = channel_groups(cfg).get(n)
        if g and any(m not in self.ifaces for m in g['members']) and (g['mode'] == 'on') != (mode == 'on'):
            print(f'Command rejected (Port-channel{n}, {self.ifaces[0]}): Invalid etherchnl mode')
            return

        def fn(cfg):
            po = cfg['interfaces'].setdefault(f'po{n}', {})
            if not po:
                # Ciscoと同じく、最初のメンバーのVLAN設定を引き継いでport-channelを作る
                src = cfg['interfaces'].get(self.ifaces[0], {})
                po.update({k: src[k] for k in ('mode', 'access_vlan', 'allowed', 'native') if k in src})
                if not po:
                    po['mode'] = 'access'
            for name in self.ifaces:
                port_cfg(cfg, name)['channel_group'] = {'id': n, 'mode': mode}
        if not g:
            print(f'Creating a port-channel interface Port-channel {n}')
        self.modify(fn)

    def set_discovery(self, **changes):
        def fn(cfg):
            d = cfg.setdefault('discovery', {})
            for k, v in changes.items():
                if v is None:
                    d.pop(k, None)
                else:
                    d[k] = v
            if not d:
                cfg.pop('discovery')
        self.modify(fn)

    def set_logging(self, **changes):
        def fn(cfg):
            lg = cfg.setdefault('logging', {})
            for k, v in changes.items():
                if v is None:
                    lg.pop(k, None)
                else:
                    lg[k] = v
            if not lg:
                cfg.pop('logging')
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
        self.mode = 'config' if self.mode in SUB_MODES else 'exec'

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
                'vlan': f'{host}(config-vlan)#', 'mst': f'{host}(config-mst)#', 'svi': f'{host}(config-if)#',
                'line': f'{host}(config-line)#', 'user': f'{host}>'}[self.mode]

    def execute(self, line):
        # Ciscoと同じく「show ... | include 正規表現」等で出力を絞る（include / exclude / begin / section）
        m = re.match(r'(.*?)\s+\|\s*(\S+)\s*(.*)$', line)
        if m:
            kind = next((k for k in ('include', 'exclude', 'begin', 'section') if k.startswith(m.group(2).lower())), None)
            if kind is None or not m.group(3):
                print('% Invalid input detected at \'^\' marker. (use | include / exclude / begin / section)')
                return
            try:
                pattern = re.compile(m.group(3))
            except re.error:
                print('% Invalid regular expression')
                return
            import contextlib
            import io
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                self.execute(m.group(1))
            print('\n'.join(filter_output(buf.getvalue().splitlines(), kind, pattern)))
            return
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
        try:
            self.login()
        except EOFError:
            return
        self.start_log_monitor()
        pending = ''
        try:
            while True:
                was = self.mode
                try:
                    line = self.input_with(pending)
                except KeyboardInterrupt:
                    # Ctrl+C：入力を捨てる。設定モードなら特権モードに戻る（Ciscoと同じ）
                    print()
                    if self.mode != 'user':
                        self.mode = 'exec'
                    self.note_config_exit(was)
                    pending = ''
                    continue
                except EOFError:
                    print()
                    if self.mode in ('exec', 'user'):
                        return
                    self.mode = 'exec'
                    self.note_config_exit(was)
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
                if ctrl_z and self.mode != 'user':  # ユーザーモードでCtrl+Zを押しても特権モードには上がらない
                    self.mode = 'exec'
                self.note_config_exit(was)
        finally:
            if saved_tty is not None:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved_tty)

    def note_config_exit(self, was):
        """設定モードから抜けた時のメッセージ（Ciscoの%SYS-5-CONFIG_I）"""
        if was not in ('exec', 'user') and self.mode in ('exec', 'user'):
            log_event('%SYS-5-CONFIG_I: Configured from console by console')

    def start_log_monitor(self):
        """ログに追記されたメッセージを、入力中の行を壊さずにコンソールへ流す（Ciscoのlogging console）。
        入力中の行はreadlineに描き直してもらう"""
        if not sys.stdin.isatty():
            return
        try:
            import ctypes
            redraw = ctypes.CDLL('libreadline.so.8').rl_forced_update_display
        except (OSError, AttributeError):
            redraw = None

        def run():
            ino, pos = None, 0
            try:
                st = os.stat(LOG_FILE)
                ino, pos = st.st_ino, st.st_size
            except OSError:
                pass
            while True:
                time.sleep(0.5)
                try:
                    st = os.stat(LOG_FILE)
                except OSError:
                    ino, pos = None, 0
                    continue
                if st.st_ino != ino:
                    ino, pos = st.st_ino, 0
                if st.st_size < pos:
                    pos = 0
                if st.st_size == pos:
                    continue
                try:
                    with open(LOG_FILE) as f:
                        f.seek(pos)
                        data = f.read()
                        pos = f.tell()
                except OSError:
                    continue
                if not data.strip() or not self.cfg().get('logging', {}).get('console', True):
                    continue
                sys.stdout.write('\r\x1b[K' + data)
                sys.stdout.flush()
                if redraw and self.waiting_input:
                    redraw()
        threading.Thread(target=run, daemon=True).start()

    def input_with(self, text):
        import readline
        readline.set_startup_hook(lambda: readline.insert_text(text))
        self.waiting_input = True
        try:
            return input(self.prompt())
        finally:
            self.waiting_input = False
            readline.set_startup_hook()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--agent':
        agent()
    else:
        Cli().run()


if __name__ == '__main__':
    main()
