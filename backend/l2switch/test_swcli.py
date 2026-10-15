"""swcli（L2スイッチのCisco風CLI）のテスト（2026-10-15追加）。

コンテナの外（ホストのPython）でも動くよう、設定の置き場所を一時ディレクトリに、ポートの一覧を固定の値に
差し替えて、CLIの解釈と設定の保存・表示だけを確かめる（ブリッジやmstpdを実際に動かす部分は対象外）。

    python3 -m unittest -v test_swcli    （backend/l2switch/で）
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import os
import re
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader('swcli', os.path.join(HERE, 'swcli.py'))
_spec = importlib.util.spec_from_loader('swcli', _loader)
sw = importlib.util.module_from_spec(_spec)
_loader.exec_module(sw)

PORTS = ['eth1', 'eth2', 'eth3', 'eth4']


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = {k: getattr(sw, k) for k in ('RUN_DIR', 'RUNNING', 'STARTUP_DIR', 'STARTUP', 'LOG_FILE', 'system_ports')}
        sw.RUN_DIR = self.tmp.name
        sw.RUNNING = os.path.join(self.tmp.name, 'running.json')
        sw.STARTUP_DIR = os.path.join(self.tmp.name, 'startup')
        sw.STARTUP = os.path.join(sw.STARTUP_DIR, 'startup.json')
        sw.LOG_FILE = os.path.join(self.tmp.name, 'log')
        sw.system_ports = lambda: list(PORTS)

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(sw, k, v)
        self.tmp.cleanup()

    def run_lines(self, lines, cli=None):
        cli = cli or sw.Cli()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            for line in lines:
                cli.execute(line)
        return buf.getvalue()

    def configure(self, lines):
        return self.run_lines(['configure terminal', *lines, 'end'])

    def running_config(self):
        return self.run_lines(['show running-config'])


class ParsingTest(unittest.TestCase):
    def test_vlan_list(self):
        self.assertEqual(sw.parse_vlan_list('10,20-22,5'), [5, 10, 20, 21, 22])
        self.assertIsNone(sw.parse_vlan_list('0'))
        self.assertIsNone(sw.parse_vlan_list('4095'))
        self.assertIsNone(sw.parse_vlan_list('30-20'))
        self.assertEqual(sw.format_vlan_list([1, 2, 3, 5, 7, 8]), '1-3,5,7-8')

    def test_iface_names(self):
        for text in ('eth1', 'e1', 'Ethernet1', 'ETH1'):
            self.assertEqual(sw.norm_iface(text), 'eth1', text)
        self.assertEqual(sw.norm_iface('po3'), 'po3')
        self.assertEqual(sw.norm_iface('port-channel3'), 'po3')
        self.assertIsNone(sw.norm_iface('eth0'))  # 管理用は触らせない
        self.assertIsNone(sw.norm_iface('gi0/1'))
        self.assertEqual(sw.norm_iface_range('eth1-3,eth5'), ['eth1', 'eth2', 'eth3', 'eth5'])
        self.assertIsNone(sw.norm_iface_range('eth3-1'))

    def test_tokenize(self):
        self.assertEqual(sw.tokenize('interface eth 1'), ['interface', 'eth1'])
        self.assertEqual(sw.tokenize('int vlan10'), ['int', 'vlan', '10'])
        # Ciscoと同じ空白入りのrange（2026-10-15）
        self.assertEqual(sw.tokenize('interface range eth2 - 3 , eth 5'), ['interface', 'range', 'eth2-3,eth5'])
        # range以外の行の「-」はそのまま
        self.assertEqual(sw.tokenize('description a - b'), ['description', 'a', '-', 'b'])

    def test_masks(self):
        self.assertEqual(sw.mask_to_prefix('255.255.255.0'), 24)
        self.assertIsNone(sw.mask_to_prefix('255.0.255.0'))
        self.assertEqual(sw.prefix_to_mask(20), '255.255.240.0')

    def test_mac(self):
        self.assertEqual(sw.parse_mac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff')
        self.assertEqual(sw.parse_mac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff')
        self.assertEqual(sw.cisco_mac('aa:bb:cc:dd:ee:ff'), 'aabb.ccdd.eeff')

    def test_password_types(self):
        # type 7はCiscoの機器と互換（よく知られた例：0822455D0A16 = cisco）
        self.assertEqual(sw.type7_decode('0822455D0A16'), 'cisco')
        for plain in ('cisco', 'p@ss w0rd!', 'x' * 25):
            self.assertEqual(sw.type7_decode(sw.type7_encode(plain)), plain)
        hashed = sw.type9_hash('secret')
        self.assertTrue(hashed.startswith('$9$'))
        self.assertTrue(sw.type9_check('secret', hashed))
        self.assertFalse(sw.type9_check('Secret', hashed))

    def test_filter_output(self):
        lines = ['interface eth1', ' switchport mode access', '!', 'interface eth2', ' shutdown', '!']
        self.assertEqual(sw.filter_output(lines, 'include', re.compile('eth')), ['interface eth1', 'interface eth2'])
        self.assertEqual(sw.filter_output(lines, 'begin', re.compile('eth2')), lines[3:])
        self.assertEqual(sw.filter_output(lines, 'section', re.compile('eth2')), ['interface eth2', ' shutdown'])


class CliTest(CliTestCase):
    def test_invalid_input_marker(self):
        out = self.run_lines(['show runnin-config'])
        self.assertIn('^', out)
        self.assertIn('% Invalid input', out)

    def test_abbreviations(self):
        self.configure(['host SW1', 'int e1', 'sw mo acc', 'sw acc vl 10'])
        cfg = sw.load(sw.RUNNING)
        self.assertEqual(cfg['hostname'], 'SW1')
        self.assertEqual(sw.port_view(cfg, 'eth1')['access_vlan'], 10)

    def test_access_vlan_creates_vlan(self):
        out = self.configure(['interface eth1', 'switchport access vlan 30'])
        self.assertIn('30', sw.load(sw.RUNNING)['vlans'])
        self.assertIn('Access VLAN does not exist. Creating vlan 30', out)

    def test_interface_range(self):
        self.configure(['interface range eth2 - 3', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20-30'])
        cfg = sw.load(sw.RUNNING)
        for name in ('eth2', 'eth3'):
            self.assertEqual(sw.port_view(cfg, name)['mode'], 'trunk')
            self.assertEqual(sw.port_view(cfg, name)['allowed'], [10, *range(20, 31)])
        self.assertEqual(sw.port_view(cfg, 'eth1')['mode'], 'access')

    def test_pipe_include(self):
        self.configure(['hostname SW1', 'interface eth1', 'description uplink'])
        self.assertEqual(self.run_lines(['show running-config | include description']).strip(), 'description uplink')

    def test_running_config_round_trip(self):
        """show running-configを別のスイッチに流し込むと同じ設定になる（write memoryの保存形式と同じ考え方）"""
        self.configure([
            'hostname SW9',
            'vlan 10', 'name users', 'exit',
            'vlan 20,30',
            'spanning-tree mode mst',
            'spanning-tree mst configuration', 'name region1', 'revision 2', 'instance 1 vlan 10,20', 'exit',
            'spanning-tree mst 1 priority 4096',
            'enable secret cisco',
            'cdp run', 'lldp run',
            'interface eth1', 'description to PC', 'switchport mode access', 'switchport access vlan 10',
            'spanning-tree portfast', 'spanning-tree bpduguard enable',
            'switchport port-security', 'switchport port-security maximum 2', 'switchport port-security violation restrict', 'exit',
            'interface range eth2 - 3', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20,30',
            'channel-group 1 mode active', 'exit',
            'interface eth4', 'shutdown', 'no cdp enable', 'exit',
            # SVIはCiscoと同じく作った時はshutdown。no shutdownした状態はrunning-configに何も出ないので、
            # 流し込み直すとshutdownに戻る（Ciscoも同じ）。ここではshutdownのままで往復を確かめる
            'interface vlan 10', 'ip address 192.168.10.2 255.255.255.0', 'exit',
            'ip default-gateway 192.168.10.1',
            'line console 0', 'password 7 0822455D0A16', 'login', 'exit',
        ])
        first_cfg = sw.load(sw.RUNNING)
        first = self.running_config()
        self.assertIn('enable secret 9 $9$', first)
        self.assertIn('interface Port-channel1', first)

        os.remove(sw.RUNNING)
        body = [line for line in first.splitlines() if line and not line.startswith(('Building', 'Current configuration', '!', 'end'))]
        out = self.configure(body)
        self.assertNotIn('% Invalid', out, out)
        self.assertNotIn('% Incomplete', out, out)
        self.assertEqual(self.running_config(), first)
        # 内部のJSONは既定値を明示するかどうかで違ってよい。各ポートの実際の設定値で比べる
        second_cfg = sw.load(sw.RUNNING)
        for name in sw.all_ports(first_cfg):
            self.assertEqual(sw.port_view(second_cfg, name), sw.port_view(first_cfg, name), name)
        for key in ('hostname', 'vlans', 'svi', 'default_gateway'):
            self.assertEqual(second_cfg.get(key), first_cfg.get(key), key)

    def test_svi_shutdown(self):
        self.configure(['interface vlan 10', 'ip address 10.0.0.2 255.255.255.0'])
        self.assertIn(' shutdown', self.running_config())
        self.configure(['interface vlan 10', 'no shutdown'])
        self.assertNotIn(' shutdown', self.running_config())
        self.assertFalse(sw.svi_view(sw.load(sw.RUNNING), 10)['shutdown'])

    def test_write_memory_and_startup(self):
        self.configure(['hostname SAVED'])
        self.run_lines(['write memory'])
        self.assertEqual(sw.load(sw.STARTUP)['hostname'], 'SAVED')
        self.assertIn('hostname SAVED', self.run_lines(['show startup-config']))


if __name__ == '__main__':
    unittest.main()
