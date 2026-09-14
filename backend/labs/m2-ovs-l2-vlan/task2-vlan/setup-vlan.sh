#!/bin/sh
# containerlab の ovs-bridge kind はブリッジの事前作成・ポートのVLAN設定を
# トポロジファイルでは表現できないため、deploy 前後に ovs-vsctl で直接設定する。
set -eu

BR=sw1

echo "== [1] ブリッジ ${BR} を作成（存在しなければ） =="
ovs-vsctl br-exists "${BR}" || ovs-vsctl add-br "${BR}"

echo "== [2] deploy =="
containerlab deploy -t m2-task2.clab.yml

echo "== [3] アクセスポートに VLAN tag を設定 =="
# pc1, pc3 = VLAN10（アクセス）/ pc2 = VLAN20（アクセス）
ovs-vsctl set port eth1 tag=10   # sw1:eth1 <-> pc1
ovs-vsctl set port eth2 tag=20   # sw1:eth2 <-> pc2
ovs-vsctl set port eth3 tag=10   # sw1:eth3 <-> pc3

echo "== [4] トランクポートに VLAN10+20 を設定 =="
ovs-vsctl set port eth4 trunks=10,20   # sw1:eth4 <-> trunk

echo "== [5] 各コンテナに IP を設定 =="
docker exec clab-m2-task2-pc1 ip addr add 10.0.10.1/24 dev eth1
docker exec clab-m2-task2-pc3 ip addr add 10.0.10.3/24 dev eth1
docker exec clab-m2-task2-pc2 ip addr add 10.0.20.2/24 dev eth1

# trunk ノードは 802.1Q サブインターフェースで VLAN10/20 両方に参加
docker exec clab-m2-task2-trunk ip link add link eth1 name eth1.10 type vlan id 10
docker exec clab-m2-task2-trunk ip link add link eth1 name eth1.20 type vlan id 20
docker exec clab-m2-task2-trunk ip addr add 10.0.10.9/24 dev eth1.10
docker exec clab-m2-task2-trunk ip addr add 10.0.20.9/24 dev eth1.20
docker exec clab-m2-task2-trunk ip link set eth1 up
docker exec clab-m2-task2-trunk ip link set eth1.10 up
docker exec clab-m2-task2-trunk ip link set eth1.20 up

echo "== 設定完了。ovs-vsctl show =="
ovs-vsctl show
