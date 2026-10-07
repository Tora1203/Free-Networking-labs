#!/bin/sh
# ovs-helperのserver.js専用の最小権限ラッパー。
#
# なぜこれが必要か（2026-10-07実機確認）:
#   `ovs-vsctl del-port`はOVSブリッジからポートを切り離すだけで、裏にあるvethデバイス自体は
#   カーネルに残る。再deploy時にcontainerlabが同名のvethを作ろうとして
#   `already exists`で失敗する。vethを本当に消すには`ip link delete`が必要だが、
#   これにはCAP_NET_ADMINが要る（labuser権限で動くovs-helperからは`Operation not permitted`）。
#
# なぜsetcapではなくsudoersにしたか（2026-10-07実機確認）:
#   最初`setcap cap_net_admin+ep`をこのスクリプト自体に付けてみたが、それでも
#   `RTNETLINK answers: Operation not permitted`になった。Linuxのファイルcapabilityは
#   shebangスクリプトには効かない（カーネルがexecveするのは実際には`/bin/sh`であり、
#   capabilityはスクリプトファイルのinodeに付けても実行されるインタプリタ本体には
#   引き継がれないという既知の制限）。そのため`/etc/sudoers.d/`での限定NOPASSWD許可に
#   切り替えた。
#
# なぜ`ip`本体を直接sudoersで許可しないか:
#   `ip`本体を丸ごと許可すると、ルーティング変更等ホスト全体に関わる操作まで
#   パスワード無しで実行可能になってしまう。このラッパーは「p-xxxxxxxx形式の
#   インターフェース名のdeleteだけ」しか許可しないので、このスクリプト1本だけを
#   sudoersで許可すれば操作範囲を絞れる。
#
# セットアップ（初回のみ、sudo必要）:
#   sudo cp backend/ovs-helper/link-delete.sh /usr/local/sbin/ovs-helper-link-delete
#   sudo chown root:clab_admins /usr/local/sbin/ovs-helper-link-delete
#   sudo chmod 750 /usr/local/sbin/ovs-helper-link-delete
#   echo 'labuser ALL=(root) NOPASSWD: /usr/local/sbin/ovs-helper-link-delete' | sudo tee /etc/sudoers.d/ovs-helper-link-delete
#   sudo chmod 440 /etc/sudoers.d/ovs-helper-link-delete
#   sudo visudo -c

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
