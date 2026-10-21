"""ACL（acl.py、Cisco風のパケットフィルタ）のテスト（2026-10-21追加）。

    python3 -m unittest -v test_acl    （backend/l2switch/で）
"""
import unittest

import acl


def entry(kind, line):
    return acl.entry_text(kind, line.split())


class ParseTest(unittest.TestCase):
    def test_numbered_acl_kinds(self):
        self.assertEqual(acl.acl_kind_of_number('10'), 'standard')
        self.assertEqual(acl.acl_kind_of_number('1300'), 'standard')
        self.assertEqual(acl.acl_kind_of_number('101'), 'extended')
        self.assertEqual(acl.acl_kind_of_number('2000'), 'extended')
        self.assertIsNone(acl.acl_kind_of_number('200'))
        self.assertIsNone(acl.acl_kind_of_number('web'))

    def test_standard_entries(self):
        self.assertEqual(entry('standard', 'permit 10.0.0.0 0.0.0.255'), 'permit 10.0.0.0 0.0.0.255')
        self.assertEqual(entry('standard', 'deny host 10.0.0.1'), 'deny host 10.0.0.1')
        self.assertEqual(entry('standard', 'deny 10.0.0.1'), 'deny host 10.0.0.1')  # 単独のアドレスはホスト
        self.assertEqual(entry('standard', 'permit any'), 'permit any')

    def test_extended_entries(self):
        self.assertEqual(entry('extended', 'permit ip any any'), 'permit ip any any')
        self.assertEqual(entry('extended', 'permit tcp 10.0.0.0 0.0.0.255 any eq www'), 'permit tcp 10.0.0.0 0.0.0.255 any eq 80')
        self.assertEqual(entry('extended', 'deny udp any range 1000 2000 host 10.1.1.1 eq domain'), 'deny udp any range 1000 2000 host 10.1.1.1 eq 53')
        self.assertEqual(entry('extended', 'permit icmp any any echo'), 'permit icmp any any echo')
        self.assertEqual(entry('extended', 'permit tcp any any established log'), 'permit tcp any any established')

    def test_errors(self):
        for kind, line in (('extended', 'permit'), ('extended', 'allow ip any any'), ('extended', 'permit gre any any'), ('extended', 'permit ip any'),
                           ('extended', 'permit ip 10.0.0.1 any'), ('extended', 'permit tcp any any eq 99999'), ('extended', 'permit tcp any any eq nosuch'),
                           ('extended', 'permit tcp any any range 80 20'), ('extended', 'permit ip any any established'), ('standard', 'permit 10.0.0.0 0.0.0.255 extra'),
                           ('extended', 'permit ip 300.0.0.0 0.0.0.255 any')):
            with self.assertRaises(acl.AclError, msg=line):
                acl.entry_text(kind, line.split())


class NftTest(unittest.TestCase):
    def rule(self, kind, line, seq=10, name='101'):
        return acl.nft_rule(kind, name, seq, {'seq': seq, 'text': entry(kind, line)})

    def test_address_and_wildcard(self):
        self.assertEqual(acl.wildcard_prefix('0.0.0.255'), 24)
        self.assertEqual(acl.wildcard_prefix('0.0.0.0'), 32)
        self.assertEqual(acl.wildcard_prefix('255.255.255.255'), 0)
        self.assertIsNone(acl.wildcard_prefix('0.255.0.255'))
        self.assertEqual(acl.nft_address('saddr', ('wild', '10.0.5.7', '0.0.0.255')), 'ip saddr 10.0.5.0/24')
        self.assertEqual(acl.nft_address('daddr', ('host', '10.1.1.1')), 'ip daddr 10.1.1.1')
        self.assertIsNone(acl.nft_address('saddr', ('any',)))
        # 連続しないワイルドカードは、ビットマスクで比べる
        self.assertEqual(acl.nft_address('saddr', ('wild', '10.0.1.0', '0.255.0.255')), 'ip saddr & 255.0.255.0 == 10.0.1.0')

    def test_rules(self):
        self.assertEqual(self.rule('extended', 'permit ip any any'), 'counter return comment "101 10"')
        self.assertEqual(self.rule('extended', 'deny tcp 10.0.0.0 0.0.0.255 any eq 80'),
                         'meta l4proto tcp ip saddr 10.0.0.0/24 tcp dport 80 counter drop comment "101 10"')
        self.assertEqual(self.rule('extended', 'permit udp any host 10.1.1.1 range 100 200'),
                         'meta l4proto udp ip daddr 10.1.1.1 udp dport 100-200 counter return comment "101 10"')
        self.assertEqual(self.rule('extended', 'deny icmp any any echo'), 'ip protocol icmp icmp type echo-request counter drop comment "101 10"')
        self.assertEqual(self.rule('extended', 'permit tcp any any established'),
                         'meta l4proto tcp tcp flags & (ack | rst) != 0 counter return comment "101 10"')
        self.assertEqual(self.rule('extended', 'deny tcp any gt 1023 any neq 22'), 'meta l4proto tcp tcp sport > 1023 tcp dport != 22 counter drop comment "101 10"')
        self.assertEqual(self.rule('standard', 'deny host 10.0.0.1', name='10'), 'ip saddr 10.0.0.1 counter drop comment "10 10"')

    def test_compile_script(self):
        acls = {'101': {'type': 'extended', 'entries': [{'seq': 20, 'text': 'permit ip any any'}, {'seq': 10, 'text': 'deny icmp any any echo'}]},
                'web': {'type': 'extended', 'entries': [{'seq': 10, 'text': 'permit tcp any any eq 80'}]}}
        script = acl.compile_nft(acls, [('vlan10', 'in', '101'), ('vlan20', 'out', 'web'), ('eth2', 'in', 'missing')])
        self.assertIn('table ip fnl_acl {', script)
        # seqの順に並ぶ。ACLの終わりは暗黙の拒否
        self.assertLess(script.index('comment "101 10"'), script.index('comment "101 20"'))
        self.assertIn('counter drop comment "101 implicit-deny"', script)
        self.assertIn('iifname "vlan10" jump acl_101', script)
        self.assertIn('oifname "vlan20" jump acl_web', script)
        self.assertEqual(script.count('iifname "vlan10" jump acl_101'), 2)  # forward と input（スイッチ宛）
        self.assertNotIn('missing', script)
        self.assertEqual(acl.compile_nft(acls, []), '')
        self.assertEqual(acl.compile_nft(acls, [('vlan10', 'in', 'missing')]), '')

    def test_counters(self):
        out = '    ip saddr 10.0.0.0/24 counter packets 7 bytes 588 drop comment "101 10"\n    counter packets 1 bytes 64 return comment "101 20"\n'
        self.assertEqual(acl.parse_counters(out), {('101', 10): 7, ('101', 20): 1})


class FrrMirrorTest(unittest.TestCase):
    def test_standard_acls_become_frr_access_lists(self):
        acls = {'10': {'type': 'standard', 'entries': [{'seq': 10, 'text': 'permit 10.0.0.0 0.0.0.255'}, {'seq': 20, 'text': 'deny host 10.9.9.9'},
                                                      {'seq': 30, 'text': 'permit 10.0.1.0 0.255.0.255'}, {'seq': 40, 'text': 'permit any'}]},
                '101': {'type': 'extended', 'entries': [{'seq': 10, 'text': 'permit ip any any'}]}}
        self.assertEqual(acl.frr_access_list_lines(acls), {'10': [(10, 'permit', '10.0.0.0/24'), (20, 'deny', '10.9.9.9/32'), (40, 'permit', 'any')]})


if __name__ == '__main__':
    unittest.main()
