#!/bin/sh
# ovs-helperのserver.js専用の最小権限ラッパー（`POST /frr-config`用）。
#
# なぜ必要か（2026-10-13実機確認）:
#   ovs-helperは`labuser`権限で動くが、ラボのディレクトリは
#   `$CLAB_LABS_ROOT/<ユーザー名>/`に`drwxr-x---`でユーザーごとに分離されている（clab-api-serverの
#   所有権分離）。そのため別ユーザー（例：labuser2）のラボに`frr-config/<router>/`を作ろうとすると
#   `EACCES: permission denied`でdeployできなかった。ovs-helperを丸ごとrootにするのではなく、
#   「そのユーザーのラボ配下にfrr-configを作って所有者をそのユーザーにする」だけを行う
#   このラッパーをsudoersで許可する（ovs-bridge時代のlink-delete.shと同じ方針。link-delete.shは2026-10-15に削除）。
#
# 呼び出し：sudo -n ovs-helper-frr-config-init <ユーザー名> <ラボ名> <ノード名> [router|switch]
#   router（省略時）：frr-config/<ノード名>/にdaemons/frr.conf/vtysh.confを作る。
#     daemonsの内容は標準入力で受け取る（server.jsのFRR_DEFAULT_DAEMONSが唯一の定義元）。
#     既存ファイルは絶対に上書きしない（学生が`write memory`した設定を守るため）。
#   switch（2026-10-14追加）：switch-config/<ノード名>/を空のディレクトリとして作るだけ。
#     L2スイッチ（backend/l2switch/）の/etc/fnl-switchにbind mountし、swcliの`write memory`
#     （startup.json）をコンテナの作り直しを越えて残す。中身はコンテナ内のroot（swcli）が書く。
#
# セットアップ（初回のみ、sudo必要）:
#   sudo cp backend/ovs-helper/frr-config-init.sh /usr/local/sbin/ovs-helper-frr-config-init
#   sudo chown root:clab_admins /usr/local/sbin/ovs-helper-frr-config-init
#   sudo chmod 750 /usr/local/sbin/ovs-helper-frr-config-init
#   echo 'labuser ALL=(root) NOPASSWD: /usr/local/sbin/ovs-helper-frr-config-init' | sudo tee /etc/sudoers.d/ovs-helper-frr-config-init
#   sudo chmod 440 /etc/sudoers.d/ovs-helper-frr-config-init
#   sudo visudo -c

set -eu

ROOT=/var/lib/containerlab/labs
user="${1:-}"
lab="${2:-}"
router="${3:-}"
mode="${4:-router}"

fail() { echo "refused: $1" >&2; exit 1; }

# server.jsのSAFE_USERNAME_PATTERN / SAFE_PATH_SEGMENT_PATTERNと同じ形式のみ許可
printf '%s' "$user"   | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || fail "invalid user"
printf '%s' "$lab"    | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$'  || fail "invalid lab"
printf '%s' "$router" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$'  || fail "invalid router"
case "$mode" in router) sub=frr-config ;; switch) sub=switch-config ;; *) fail "invalid mode" ;; esac

entry="$(getent passwd "$user")" || fail "unknown user"
uid="$(printf '%s' "$entry" | cut -d: -f3)"
gid="$(printf '%s' "$entry" | cut -d: -f4)"

# そのユーザーのラボルートが実在し、シンボリックリンクでなく、本人所有であること
udir="$ROOT/$user"
[ -d "$udir" ] && [ ! -L "$udir" ] || fail "user dir not found"
[ "$(stat -c %u "$udir")" = "$uid" ] || fail "user dir owner mismatch"

# ラボ以下は存在しなければ本人所有で作る（deploy前に呼ばれるため）。
# 既存のものがシンボリックリンクなら拒否する
for d in "$udir/$lab" "$udir/$lab/$sub" "$udir/$lab/$sub/$router"; do
  [ -L "$d" ] && fail "symlink in path"
  [ -e "$d" ] || install -d -m 0750 -o "$uid" -g "$gid" "$d"
done
dir="$udir/$lab/$sub/$router"
[ "$mode" = switch ] && exit 0

write_if_missing() {  # $1=ファイル名、内容は標準入力
  f="$dir/$1"
  [ -L "$f" ] && fail "symlink in path"
  if [ ! -e "$f" ]; then
    cat > "$f"
    chown "$uid:$gid" "$f"
    chmod 0644 "$f"
  fi
}

head -c 8192 | write_if_missing daemons
printf 'frr version 10.2.1\nfrr defaults traditional\nhostname %s\n!\nline vty\n!\n' "$router" | write_if_missing frr.conf
printf 'service integrated-vtysh-config\n' | write_if_missing vtysh.conf
