"""L3スイッチの機能（l3.py、swcliのプラグイン）のテスト（2026-10-21追加）。

test_swcliと同じく、コンテナの外でCLIの解釈と設定の保存・表示だけを確かめる
（FRR・nftablesを実際に動かす部分は、fnl/l3switchのコンテナの中で確かめる）。

    python3 -m unittest -v test_l3    （backend/l2switch/で）
"""
import unittest

import l3
from test_swcli import CliTestCase, sw


class PluginLoadTest(unittest.TestCase):
    def test_l3_plugin_is_loaded(self):
        # backend/l2switch/ にl3.pyがあるので読み込まれる。L2スイッチのイメージにはl3.pyが無く、PLUGINSは空のまま
        self.assertEqual(len(sw.PLUGINS), 1)


class L3CommandTest(CliTestCase):
    def test_ip_routing_is_off_by_default_and_toggles(self):
        self.assertNotIn('ip routing', self.running_config())
        self.configure(['ip routing'])
        self.assertIn('\nip routing\n', self.running_config())
        self.configure(['no ip routing'])
        self.assertNotIn('ip routing', self.running_config())

    def test_static_routes(self):
        self.configure(['ip route 10.1.0.0 255.255.255.0 192.168.0.2', 'ip route 0.0.0.0 0.0.0.0 192.168.0.1'])
        config = self.running_config()
        self.assertIn('ip route 10.1.0.0 255.255.255.0 192.168.0.2', config)
        self.assertIn('ip route 0.0.0.0 0.0.0.0 192.168.0.1', config)
        # 同じ経路を2回入れても1つ
        self.configure(['ip route 10.1.0.0 255.255.255.0 192.168.0.2'])
        self.assertEqual(self.running_config().count('ip route 10.1.0.0'), 1)
        # 次のホップを付けた削除は、その経路だけ。付けなければ宛先の経路すべて
        self.configure(['ip route 10.1.0.0 255.255.255.0 192.168.0.3'])
        self.configure(['no ip route 10.1.0.0 255.255.255.0 192.168.0.2'])
        config = self.running_config()
        self.assertNotIn('192.168.0.2', config)
        self.assertIn('ip route 10.1.0.0 255.255.255.0 192.168.0.3', config)
        self.configure(['no ip route 10.1.0.0 255.255.255.0'])
        self.assertNotIn('10.1.0.0', self.running_config())

    def test_static_route_rejects_host_bits_and_bad_mask(self):
        out = self.configure(['ip route 10.1.0.1 255.255.255.0 192.168.0.2'])
        self.assertIn('Inconsistent address and mask', out)
        out = self.configure(['ip route 10.1.0.0 255.0.255.0 192.168.0.2'])
        self.assertIn('Invalid input', out)
        self.assertNotIn('ip route', self.running_config())

    def test_routed_port(self):
        out = self.configure(['interface eth2', 'no switchport', 'ip address 10.0.0.1 255.255.255.252'])
        self.assertNotIn('%', out)
        config = self.running_config()
        block = config.split('interface eth2\n')[1].split('!')[0]
        self.assertIn(' no switchport', block)
        self.assertIn(' ip address 10.0.0.1 255.255.255.252', block)
        self.assertNotIn('switchport mode', block)
        # ブリッジに入れるポートからは外れる
        self.assertNotIn('eth2', sw.bridge_ports(sw.load(sw.RUNNING)))
        self.assertIn('eth1', sw.bridge_ports(sw.load(sw.RUNNING)))

    def test_switchport_back_clears_the_address(self):
        self.configure(['interface eth2', 'no switchport', 'ip address 10.0.0.1 255.255.255.252'])
        self.configure(['interface eth2', 'switchport'])
        self.assertIn('eth2', sw.bridge_ports(sw.load(sw.RUNNING)))
        block = self.running_config().split('interface eth2\n')[1].split('!')[0]
        self.assertNotIn('ip address', block)
        self.assertNotIn('no switchport', block)

    def test_ip_address_needs_a_routed_port(self):
        out = self.configure(['interface eth2', 'ip address 10.0.0.1 255.255.255.252'])
        self.assertIn('switchport', out)
        self.assertNotIn('10.0.0.1', self.running_config())

    def test_routed_port_cannot_join_a_port_channel_and_vice_versa(self):
        self.configure(['interface eth3', 'channel-group 1 mode on'])
        out = self.configure(['interface eth3', 'no switchport'])
        self.assertIn('port-channel', out)
        self.assertNotIn('no switchport', self.running_config())

    def test_range_is_refused(self):
        out = self.configure(['interface range eth1-2', 'no switchport'])
        self.assertIn('one interface', out)

    def test_show_ip_route_without_routing(self):
        self.assertIn('Default gateway is not set', self.run_lines(['show ip route']))

    def test_routes_survive_write_memory_format(self):
        self.configure(['ip routing', 'ip route 10.1.0.0 255.255.255.0 192.168.0.2'])
        self.run_lines(['write memory'])
        saved = sw.load(sw.STARTUP)
        self.assertTrue(saved['ip_routing'])
        self.assertEqual(saved['routes'], [{'net': '10.1.0.0/24', 'nh': '192.168.0.2'}])


class TranslationTest(unittest.TestCase):
    def tr(self, proto, line):
        return l3.translate_router_command(proto, line.split(), sw.is_ipv4, sw.mask_to_prefix)

    def test_wildcard(self):
        self.assertEqual(l3.wildcard_to_prefix('0.0.0.255', sw.is_ipv4, sw.mask_to_prefix), 24)
        self.assertEqual(l3.wildcard_to_prefix('0.0.0.3', sw.is_ipv4, sw.mask_to_prefix), 30)
        self.assertIsNone(l3.wildcard_to_prefix('0.255.0.255', sw.is_ipv4, sw.mask_to_prefix))
        self.assertEqual(l3.prefix_to_wildcard(24), '0.0.0.255')
        self.assertEqual(l3.prefix_to_wildcard(0), '255.255.255.255')

    def test_ospf_network_and_router_id(self):
        self.assertEqual(self.tr('ospf', 'network 10.0.0.0 0.0.0.255 area 0'), ('network 10.0.0.0/24 area 0', None))
        self.assertEqual(self.tr('ospf', 'no network 10.0.0.0 0.0.0.255 area 0'), ('no network 10.0.0.0/24 area 0', None))
        self.assertEqual(self.tr('ospf', 'network 10.0.0.0/24 area 0'), ('network 10.0.0.0/24 area 0', None))
        self.assertEqual(self.tr('ospf', 'router-id 1.1.1.1'), ('ospf router-id 1.1.1.1', None))
        self.assertEqual(self.tr('ospf', 'no router-id'), ('no ospf router-id', None))
        self.assertIsNotNone(self.tr('ospf', 'network 10.0.0.0 0.255.0.255 area 0')[1])

    def test_ospf_other_commands(self):
        self.assertEqual(self.tr('ospf', 'passive-interface vlan 10'), ('passive-interface vlan10', None))
        self.assertEqual(self.tr('ospf', 'passive-interface default'), ('passive-interface default', None))
        self.assertEqual(self.tr('ospf', 'redistribute connected subnets'), ('redistribute connected', None))
        self.assertEqual(self.tr('ospf', 'default-information originate always'), ('default-information originate always', None))
        self.assertEqual(self.tr('bgp', 'neighbor 10.0.0.2 remote-as 65002'), ('neighbor 10.0.0.2 remote-as 65002', None))

    def test_bgp_network_aggregate_and_address_family(self):
        self.assertEqual(self.tr('bgp', 'network 10.10.1.0 mask 255.255.255.0'), ('network 10.10.1.0/24', None))
        self.assertEqual(self.tr('bgp', 'no network 10.10.1.0 mask 255.255.255.0'), ('no network 10.10.1.0/24', None))
        self.assertEqual(self.tr('bgp', 'network 10.10.1.0/24'), ('network 10.10.1.0/24', None))
        self.assertIn('Incomplete', self.tr('bgp', 'network 10.10.1.0')[1])
        self.assertIsNotNone(self.tr('bgp', 'network 10.10.1.0 mask 255.0.255.0')[1])
        self.assertEqual(self.tr('bgp', 'aggregate-address 10.10.0.0 255.255.0.0 summary-only'), ('aggregate-address 10.10.0.0/16 summary-only', None))
        self.assertEqual(self.tr('bgp', 'address-family ipv4'), ('address-family ipv4 unicast', None))
        self.assertEqual(self.tr('bgp', 'address-family ipv4 unicast'), ('address-family ipv4 unicast', None))
        self.assertEqual(self.tr('bgp', 'neighbor 10.0.0.2 remote-as 65002'), ('neighbor 10.0.0.2 remote-as 65002', None))
        self.assertEqual(self.tr('bgp', 'bgp router-id 1.1.1.1'), ('bgp router-id 1.1.1.1', None))

    def test_rip(self):
        self.assertEqual(self.tr('rip', 'network 10.0.0.0'), ('network 10.0.0.0/8', None))
        self.assertEqual(self.tr('rip', 'network 172.16.0.0'), ('network 172.16.0.0/16', None))
        self.assertEqual(self.tr('rip', 'network 192.168.1.0'), ('network 192.168.1.0/24', None))
        self.assertEqual(self.tr('rip', 'network 10.0.0.0/24'), ('network 10.0.0.0/24', None))
        self.assertEqual(self.tr('rip', 'version 2'), ('version 2', None))
        self.assertEqual(self.tr('rip', 'no auto-summary'), ('', None))  # FRRに無い。何もしない

    def test_display_bgp_and_rip(self):
        self.assertEqual(l3.display_line(' network 10.10.1.0/24', 'bgp'), ' network 10.10.1.0 mask 255.255.255.0')
        self.assertEqual(l3.display_line('  network 10.10.1.0/24', 'bgp'), '  network 10.10.1.0 mask 255.255.255.0')
        self.assertEqual(l3.display_line(' aggregate-address 10.10.0.0/16 summary-only', 'bgp'), ' aggregate-address 10.10.0.0 255.255.0.0 summary-only')
        self.assertEqual(l3.display_line(' network 10.0.0.0/8', 'rip'), ' network 10.0.0.0')
        self.assertEqual(l3.display_line(' network 10.0.0.0/24', 'rip'), ' network 10.0.0.0/24')  # クラスフルでない形はそのまま
        self.assertEqual(l3.display_line(' neighbor 10.0.0.2 remote-as 65002', 'bgp'), ' neighbor 10.0.0.2 remote-as 65002')

    def test_vrrp_command(self):
        self.assertEqual(l3.translate_vrrp_command(['1', 'ip', '10.0.0.1']), 'vrrp 1 ip 10.0.0.1')
        self.assertEqual(l3.translate_vrrp_command(['1', 'priority', '120']), 'vrrp 1 priority 120')
        self.assertEqual(l3.translate_vrrp_command(['1', 'timers', 'advertise', '3']), 'vrrp 1 advertisement-interval 3000')

    def test_vrrp_instances_come_from_the_interface_blocks(self):
        plugin = l3.L3Plugin(None)
        cfg = {'frr': ['interface vlan10', ' vrrp 1', ' vrrp 1 ip 10.10.0.1', ' vrrp 2 priority 90', '!', 'interface eth3', ' ip ospf cost 5', '!', 'router ospf', ' vrrp 9']}
        self.assertEqual(plugin.vrrp_instances(cfg), {('vlan10', 1): ['10.10.0.1'], ('vlan10', 2): []})

    def test_interface_command(self):
        self.assertEqual(l3.translate_interface_command(['ip', 'ospf', 'cost', '10']), 'ip ospf cost 10')
        self.assertEqual(l3.translate_interface_command(['ip', 'ospf', '1', 'area', '0']), 'ip ospf area 0')

    FRR_OUTPUT = '''Building configuration...

Current configuration:
!
frr version 10.2.2
frr defaults traditional
hostname sw1
service integrated-vtysh-config
!
ip route 10.99.0.0/24 10.0.0.2
!
interface vlan10
 ip ospf cost 5
exit
!
router ospf
 ospf router-id 1.1.1.1
 network 10.10.0.0/24 area 0
exit
!
end
'''

    def test_parse_frr_config_keeps_only_protocol_blocks(self):
        self.assertEqual(
            l3.parse_frr_config(self.FRR_OUTPUT),
            ['interface vlan10', ' ip ospf cost 5', '!', 'router ospf', ' ospf router-id 1.1.1.1', ' network 10.10.0.0/24 area 0'],
        )

    def test_render_frr_conf_roundtrip(self):
        lines = l3.parse_frr_config(self.FRR_OUTPUT)
        conf = l3.render_frr_conf('sw1', lines)
        self.assertIn('hostname sw1', conf)
        self.assertNotIn('ip route', conf)
        self.assertEqual(l3.parse_frr_config(conf), lines)
        self.assertTrue(l3.render_frr_conf('x', []).endswith('end\n'))

    def test_display_line(self):
        self.assertEqual(l3.display_line(' network 10.10.0.0/24 area 0'), ' network 10.10.0.0 0.0.0.255 area 0')
        self.assertEqual(l3.display_line(' ospf router-id 1.1.1.1'), ' router-id 1.1.1.1')
        self.assertEqual(l3.display_line(' ip ospf area 0'), ' ip ospf 1 area 0')
        self.assertEqual(l3.display_line(' ip ospf cost 5'), ' ip ospf cost 5')


class FrrConfigDisplayTest(CliTestCase):
    def test_policy_blocks_in_running_config(self):
        self.store(['ip prefix-list ONLY10 seq 5 permit 10.10.0.0/16 le 24', '!', 'ip prefix-list ONLY10 seq 10 deny 0.0.0.0/0 le 32', '!',
                    'route-map IN permit 10', ' match ip address prefix-list ONLY10', ' set local-preference 200'])
        config = self.running_config()
        self.assertIn('ip prefix-list ONLY10 seq 5 permit 10.10.0.0/16 le 24\nip prefix-list ONLY10 seq 10 deny 0.0.0.0/0 le 32\n!\nroute-map IN permit 10\n'
                      ' match ip address prefix-list ONLY10\n set local-preference 200\n!', config)

    def test_helper_address_on_svi_and_routed_port(self):
        self.configure(['vlan 10', 'interface vlan 10', 'ip address 10.10.0.1 255.255.255.0', 'ip helper-address 10.0.0.5', 'ip helper-address 10.0.0.6',
                        'exit', 'interface eth2', 'no switchport', 'ip address 10.0.1.1 255.255.255.0', 'ip helper-address 10.0.0.5'])
        config = self.running_config()
        self.assertIn('interface Vlan10\n ip address 10.10.0.1 255.255.255.0\n ip helper-address 10.0.0.5\n ip helper-address 10.0.0.6\n', config)
        self.assertIn('interface eth2\n no switchport\n ip address 10.0.1.1 255.255.255.0\n ip helper-address 10.0.0.5\n', config)
        self.configure(['interface vlan 10', 'no ip helper-address 10.0.0.5'])
        config = self.running_config()
        self.assertNotIn('ip helper-address 10.0.0.5\n ip helper-address 10.0.0.6', config)
        self.assertIn('ip helper-address 10.0.0.6', config)
        self.configure(['interface vlan 10', 'no ip helper-address'])
        self.assertNotIn('10.0.0.6', self.running_config())

    def test_helper_address_needs_a_valid_ip_and_a_routed_port(self):
        self.assertIn('Invalid', self.configure(['interface vlan 10', 'ip helper-address 10.0.0.999']))
        self.assertIn('switchport', self.configure(['interface eth2', 'ip helper-address 10.0.0.5']))

    def test_vrrp_needs_ip_routing(self):
        self.assertIn('IP routing not enabled', self.configure(['interface vlan 10', 'vrrp 1 ip 10.0.0.1']))

    def test_vrrp_lines_merge_into_the_interface_block(self):
        self.configure(['vlan 10', 'interface vlan 10', 'ip address 10.10.0.2 255.255.255.0', 'no shutdown'])
        self.store(['interface vlan10', ' vrrp 1 ip 10.10.0.1', ' vrrp 1 priority 120'])
        self.assertIn('interface Vlan10\n ip address 10.10.0.2 255.255.255.0\n vrrp 1 ip 10.10.0.1\n vrrp 1 priority 120\n', self.running_config())

    def test_route_map_needs_ip_routing(self):
        out = self.configure(['route-map IN permit 10'])
        self.assertIn('IP routing not enabled', out)
        out = self.configure(['ip prefix-list A seq 5 permit 10.0.0.0/8'])
        self.assertIn('IP routing not enabled', out)
        self.assertIn('Invalid', self.configure(['route-map IN allow 10']))

    def test_bgp_block_in_running_config(self):
        self.store(['router bgp 65001', ' bgp router-id 1.1.1.1', ' neighbor 10.0.0.2 remote-as 65002', ' !', ' address-family ipv4 unicast',
                    '  network 10.10.1.0/24', ' exit-address-family'])
        config = self.running_config()
        self.assertIn('router bgp 65001\n bgp router-id 1.1.1.1', config)
        self.assertIn('  network 10.10.1.0 mask 255.255.255.0\n exit-address-family', config)

    def store(self, lines):
        cfg = sw.load(sw.RUNNING)
        cfg['frr'] = lines
        sw.save(sw.RUNNING, cfg)

    def test_router_block_and_interface_block_in_running_config(self):
        self.configure(['vlan 10', 'interface vlan 10', 'ip address 10.10.0.1 255.255.255.0', 'no shutdown'])
        self.store(l3.parse_frr_config(TranslationTest.FRR_OUTPUT))
        config = self.running_config()
        self.assertIn('router ospf 1\n router-id 1.1.1.1\n network 10.10.0.0 0.0.0.255 area 0\n!', config)
        # interface vlan10 の塊は、swcliの interface Vlan10 の下に入る（別の塊として出ない）
        self.assertIn('interface Vlan10\n ip address 10.10.0.1 255.255.255.0\n ip ospf cost 5\n', config)
        self.assertNotIn('interface vlan10', config)

    def test_router_command_needs_ip_routing(self):
        out = self.configure(['router ospf'])
        self.assertIn('IP routing not enabled', out)
        self.assertNotIn('router ospf', self.running_config())

    def test_show_ospf_needs_ip_routing(self):
        self.assertIn('IP routing not enabled', self.run_lines(['show ip ospf neighbor']))

    def test_interface_ospf_needs_a_routed_port(self):
        self.configure(['ip routing'])
        out = self.configure(['interface eth2', 'ip ospf cost 10'])
        self.assertIn('switchport', out)


if __name__ == '__main__':
    unittest.main()
