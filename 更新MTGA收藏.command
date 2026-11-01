#!/bin/zsh
set -u
# This launcher delegates all behavior to the actual installed command.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
entry="$(command -v mtga-gpt-collection 2>/dev/null)"
if [[ -z "$entry" || ! -x "$entry" ]]; then
 print '收藏命令尚未安装，请在项目完成安装后重试。'
else
 "$entry" update
 result=$?
 if (( result != 0 )); then print "更新未全部完成（退出码 $result）。上次成功结果保留，请查看上方提示。"; fi
fi
print '按 Enter 关闭。'
read -r
