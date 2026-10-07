#!/bin/sh
# ovs-helperのserver.js専用の最小権限ラッパー。
#
# なぜこれが必要か（2026-10-07実機確認）:
#   `ovs-vsctl del-port`はOVSブリッジからポートを切り離すだけで、裏にあるvethデバイス自体は
#   カーネルに残る。再deploy時にcontainerlabが同名のvethを作ろうとして
#   `already exists`で失敗する。vethを本当に消すには`ip link delete`が必要だが、
#   これにはCAP_NET_ADMINが要る（labuser権限で動くovs-helperからは`Operation not permitted`）。
#
# なぜ`ip`本体ではなくこの薄いラッパーにsetcapするか:
#   `ip`本体にCAP_NET_ADMINを付けると、このサーバーの誰でも`ip`を使って
#   ホスト全体のネットワーク設定（ルーティング等）を変更できてしまう。
#   このラッパーは「p-xxxxxxxx形式のインターフェース名のdeleteだけ」しか許可せず、
#   かつファイル権限をroot:clab_adminsの750に絞ることで、実行できる人（clab_admins）と
#   できる操作（このパターンのveth削除のみ）の両方を絞る
#   （ovsdb-serverの`--ovs-user=root:clab_admins`と同じ発想）。
#
# セットアップ（初回のみ、sudo必要）:
#   sudo cp backend/ovs-helper/link-delete.sh /usr/local/sbin/ovs-helper-link-delete
#   sudo chown root:clab_admins /usr/local/sbin/ovs-helper-link-delete
#   sudo chmod 750 /usr/local/sbin/ovs-helper-link-delete
#   sudo setcap cap_net_admin+ep /usr/local/sbin/ovs-helper-link-delete

set -eu

iface="${1:-}"
case "$iface" in
  p-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ;;
  *)
    echo "refused: invalid interface name" >&2
    exit 1
    ;;
esac

exec /usr/sbin/ip link delete "$iface"
