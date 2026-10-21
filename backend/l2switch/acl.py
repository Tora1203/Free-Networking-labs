"""L3スイッチのACL（Cisco風のパケットフィルタ）の解釈とnftablesへの変換（2026-10-21〜。設計：docs/l3-switch-design.md 15章）

コンテナの外でもテストできる純粋な関数だけを置く（l3.py のプラグインが使う）。

ACLの設定（cfg['acls']）：
  {名前または番号: {'type': 'standard'|'extended', 'entries': [{'seq': 10, 'text': 'permit tcp 10.0.0.0 0.0.0.255 any eq 80'}, …]}}
  text は入力を正規化したもの（解釈し直して、nftablesの規則とFRRの access-list を作る）。
適用（cfg['svi'][N] と cfg['interfaces'][ethN]）：  acl_in / acl_out にACLの名前
"""
import ipaddress
import re

PORT_NAMES = {
    'ftp-data': 20, 'ftp': 21, 'ssh': 22, 'telnet': 23, 'smtp': 25, 'domain': 53, 'bootps': 67, 'bootpc': 68, 'tftp': 69,
    'www': 80, 'pop3': 110, 'ntp': 123, 'snmp': 161, 'bgp': 179, 'https': 443, 'syslog': 514,
}
ICMP_TYPES = {
    'echo': 'echo-request', 'echo-reply': 'echo-reply', 'unreachable': 'destination-unreachable',
    'ttl-exceeded': 'time-exceeded', 'time-exceeded': 'time-exceeded', 'redirect': 'redirect', 'router-advertisement': 'router-advertisement',
}
PROTOCOLS = ('ip', 'icmp', 'tcp', 'udp')
PORT_OPS = ('eq', 'neq', 'gt', 'lt', 'range')
SEQ_STEP = 10


class AclError(Exception):
    pass


def acl_kind_of_number(name):
    """番号付きACLの種類。番号でなければ None"""
    if not name.isdigit():
        return None
    n = int(name)
    if 1 <= n <= 99 or 1300 <= n <= 1999:
        return 'standard'
    if 100 <= n <= 199 or 2000 <= n <= 2699:
        return 'extended'
    return None


def is_ipv4(text):
    try:
        ipaddress.IPv4Address(text)
        return bool(re.fullmatch(r'\d+\.\d+\.\d+\.\d+', text))
    except ValueError:
        return False


# ---- アドレス ----

def parse_address(tokens, i, allow_single_host):
    """tokens[i:] から送信元／宛先を読む。(('any',) | ('host', ip) | ('wild', ip, wildcard), 次の位置)"""
    if i >= len(tokens):
        raise AclError('Incomplete command.')
    t = tokens[i].lower()
    if t == 'any':
        return ('any',), i + 1
    if t == 'host':
        if i + 1 >= len(tokens) or not is_ipv4(tokens[i + 1]):
            raise AclError("Invalid input detected at '^' marker.")
        return ('host', tokens[i + 1]), i + 2
    if not is_ipv4(tokens[i]):
        raise AclError("Invalid input detected at '^' marker.")
    if i + 1 < len(tokens) and is_ipv4(tokens[i + 1]):
        return ('wild', tokens[i], tokens[i + 1]), i + 2
    if allow_single_host:
        return ('host', tokens[i]), i + 1  # 標準ACLの 'permit 10.0.0.1' はそのホスト
    raise AclError('Incomplete command.')


def format_address(spec):
    if spec[0] == 'any':
        return 'any'
    if spec[0] == 'host':
        return f'host {spec[1]}'
    return f'{spec[1]} {spec[2]}'


def wildcard_prefix(wildcard):
    """ワイルドカード 0.0.0.255 → 24。連続していなければ None"""
    inverse = int(ipaddress.IPv4Address(wildcard)) ^ 0xFFFFFFFF
    bits = bin(inverse)[2:].zfill(32)
    return bits.count('1') if re.fullmatch(r'1*0*', bits) else None


def nft_address(field, spec):
    """nftablesの条件（無ければ None）。field：saddr / daddr"""
    if spec[0] == 'any':
        return None
    if spec[0] == 'host':
        return f'ip {field} {spec[1]}'
    ip, wildcard = spec[1], spec[2]
    prefix = wildcard_prefix(wildcard)
    if prefix is not None:
        net = ipaddress.ip_network(f'{ip}/{prefix}', strict=False)
        return f'ip {field} {net}'
    # 連続しないワイルドカード：ワイルドカードでない桁だけを比べる
    mask = int(ipaddress.IPv4Address(wildcard)) ^ 0xFFFFFFFF
    value = int(ipaddress.IPv4Address(ip)) & mask
    return f'ip {field} & {ipaddress.IPv4Address(mask)} == {ipaddress.IPv4Address(value)}'


# ---- ポート ----

def parse_port(tokens, i):
    """tokens[i:] が eq/neq/gt/lt/range ならそれを読む。(None | (op, a[, b]), 次の位置)"""
    if i >= len(tokens) or tokens[i].lower() not in PORT_OPS:
        return None, i
    op = tokens[i].lower()
    need = 2 if op == 'range' else 1
    vals = []
    for k in range(need):
        if i + 1 + k >= len(tokens):
            raise AclError('Incomplete command.')
        vals.append(port_number(tokens[i + 1 + k]))
    if op == 'range' and vals[0] > vals[1]:
        raise AclError('% Invalid range.')
    return (op, *vals), i + 1 + need


def port_number(text):
    if text.isdigit() and 0 <= int(text) <= 65535:
        return int(text)
    if text.lower() in PORT_NAMES:
        return PORT_NAMES[text.lower()]
    raise AclError("Invalid input detected at '^' marker.")


def format_port(spec):
    return ' '.join(str(x) for x in spec) if spec else ''


def nft_port(proto, direction, spec):
    if spec is None:
        return None
    field = f'{proto} {direction}'
    op = spec[0]
    if op == 'eq':
        return f'{field} {spec[1]}'
    if op == 'neq':
        return f'{field} != {spec[1]}'
    if op == 'gt':
        return f'{field} > {spec[1]}'
    if op == 'lt':
        return f'{field} < {spec[1]}'
    return f'{field} {spec[1]}-{spec[2]}'


# ---- 1行（エントリ） ----

def parse_entry(kind, tokens):
    """permit|deny … の1行を読む。構造化した辞書を返す。誤りは AclError"""
    if not tokens or tokens[0].lower() not in ('permit', 'deny'):
        raise AclError("Invalid input detected at '^' marker.")
    action = tokens[0].lower()
    if kind == 'standard':
        src, i = parse_address(tokens, 1, True)
        if i != len(tokens):
            if tokens[i].lower() != 'log':
                raise AclError("Invalid input detected at '^' marker.")
        return {'action': action, 'proto': 'ip', 'src': src, 'sport': None, 'dst': ('any',), 'dport': None, 'icmp': None, 'established': False}
    if len(tokens) < 2 or tokens[1].lower() not in PROTOCOLS:
        raise AclError("Invalid input detected at '^' marker.")
    proto = tokens[1].lower()
    src, i = parse_address(tokens, 2, False)
    sport = None
    if proto in ('tcp', 'udp'):
        sport, i = parse_port(tokens, i)
    dst, i = parse_address(tokens, i, False)
    dport = None
    if proto in ('tcp', 'udp'):
        dport, i = parse_port(tokens, i)
    icmp = None
    established = False
    while i < len(tokens):
        t = tokens[i].lower()
        if t == 'log':
            i += 1
        elif t == 'established' and proto == 'tcp':
            established = True
            i += 1
        elif proto == 'icmp' and t in ICMP_TYPES and icmp is None:
            icmp = t
            i += 1
        else:
            raise AclError("Invalid input detected at '^' marker.")
    return {'action': action, 'proto': proto, 'src': src, 'sport': sport, 'dst': dst, 'dport': dport, 'icmp': icmp, 'established': established}


def format_entry(e):
    """正規化した1行（show running-config に出す形）"""
    parts = [e['action'], e['proto'], format_address(e['src'])]
    if e['sport']:
        parts.append(format_port(e['sport']))
    parts.append(format_address(e['dst']))
    if e['dport']:
        parts.append(format_port(e['dport']))
    if e['icmp']:
        parts.append(e['icmp'])
    if e['established']:
        parts.append('established')
    return ' '.join(parts)


def format_standard(e):
    src = e['src']
    return f'{e["action"]} {format_address(src) if src[0] != "host" else "host " + src[1]}'


def entry_text(kind, tokens):
    """入力から、保存する正規化した文字列を作る（誤りは AclError）"""
    e = parse_entry(kind, tokens)
    return format_standard(e) if kind == 'standard' else format_entry(e)


def entry_from_text(kind, text):
    return parse_entry(kind, text.split())


# ---- nftablesへの変換 ----

def chain_name(name, used):
    base = 'acl_' + re.sub(r'\W', '_', name)
    cand, n = base, 1
    while cand in used and used[cand] != name:
        n += 1
        cand = f'{base}_{n}'
    used[cand] = name
    return cand


def nft_rule(kind, name, seq, entry):
    e = entry_from_text(kind, entry['text'])
    conds = []
    if e['proto'] == 'icmp':
        conds.append('ip protocol icmp')
    elif e['proto'] in ('tcp', 'udp'):
        conds.append(f'meta l4proto {e["proto"]}')
    for c in (nft_address('saddr', e['src']), nft_address('daddr', e['dst']),
              nft_port(e['proto'], 'sport', e['sport']), nft_port(e['proto'], 'dport', e['dport'])):
        if c:
            conds.append(c)
    if e['icmp']:
        conds.append(f'icmp type {ICMP_TYPES[e["icmp"]]}')
    if e['established']:
        conds.append('tcp flags & (ack | rst) != 0')
    verdict = 'return' if e['action'] == 'permit' else 'drop'
    return ' '.join(conds + ['counter', verdict, f'comment "{name} {seq}"'])


def compile_nft(acls, applications):
    """nftablesのスクリプトを作る。acls：cfg['acls']。applications：[(デバイス, 'in'|'out', ACLの名前)]。何も無ければ ''"""
    apps = [a for a in applications if a[2] in acls]
    if not apps:
        return ''
    used = {}
    lines = ['table ip fnl_acl {']
    names = sorted({a[2] for a in apps})
    for name in names:
        acl = acls[name]
        lines.append(f'  chain {chain_name(name, used)} {{')
        for entry in sorted(acl['entries'], key=lambda x: x['seq']):
            lines.append(f'    {nft_rule(acl["type"], name, entry["seq"], entry)}')
        lines.append(f'    counter drop comment "{name} implicit-deny"')  # ACLの終わりは暗黙の拒否
        lines.append('  }')
    forward, inp = [], []
    for dev, direction, name in sorted(apps):
        chain = chain_name(name, used)
        if direction == 'in':
            forward.append(f'iifname "{dev}" jump {chain}')
            inp.append(f'iifname "{dev}" jump {chain}')  # スイッチ宛（SVIへのping等）にも効く
        else:
            forward.append(f'oifname "{dev}" jump {chain}')
    lines.append('  chain forward {\n    type filter hook forward priority 0; policy accept;')
    lines += [f'    {x}' for x in forward]
    lines.append('  }')
    lines.append('  chain input {\n    type filter hook input priority 0; policy accept;')
    lines += [f'    {x}' for x in inp]
    lines.append('  }')
    lines.append('}')
    return '\n'.join(lines) + '\n'


def parse_counters(nft_output):
    """`nft list table ip fnl_acl` の出力から {(ACL名, seq): パケット数}"""
    out = {}
    for line in nft_output.splitlines():
        m = re.search(r'counter packets (\d+) bytes \d+.* comment "(.+) (\d+)"', line)
        if m:
            out[(m.group(2), int(m.group(3)))] = int(m.group(1))
    return out


# ---- FRR（経路用）への写し：標準ACLだけ ----

def frr_access_list_lines(acls):
    """標準ACLを FRRの access-list にする。{名前: [(seq, 'permit|deny', '10.0.0.0/24'|'any')]}。連続しないワイルドカードは写せない"""
    out = {}
    for name, acl in acls.items():
        if acl['type'] != 'standard':
            continue
        rows = []
        for entry in sorted(acl['entries'], key=lambda x: x['seq']):
            e = entry_from_text('standard', entry['text'])
            src = e['src']
            if src[0] == 'any':
                target = 'any'
            elif src[0] == 'host':
                target = f'{src[1]}/32'
            else:
                prefix = wildcard_prefix(src[2])
                if prefix is None:
                    continue
                target = str(ipaddress.ip_network(f'{src[1]}/{prefix}', strict=False))
            rows.append((entry['seq'], e['action'], target))
        out[name] = rows
    return out
