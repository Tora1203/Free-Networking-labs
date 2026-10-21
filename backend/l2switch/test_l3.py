"""L3スイッチの機能（l3.py、swcliのプラグイン）のテスト（2026-10-21追加）。

test_swcliと同じく、コンテナの外でCLIの解釈と設定の保存・表示だけを確かめる
（FRR・nftablesを実際に動かす部分は、fnl/l3switchのコンテナの中で確かめる）。

    python3 -m unittest -v test_l3    （backend/l2switch/で）
"""
import unittest

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


if __name__ == '__main__':
    unittest.main()
