#!/bin/zsh
# Stage A only. sudo is restricted to the fixed read-only helper process.
set -u
helper_dir="${0:A:h}"
project_dir="${helper_dir:h:h}"
result_dir="$project_dir/output/collection-setup"
umask 077
mkdir -p "$result_dir" || exit 1
result_tmp=$(/usr/bin/mktemp "$result_dir/probe.XXXXXXXX") || exit 1
trap '/bin/rm -f "$result_tmp"' EXIT
print '本次仅授权 mtga-reader 读取 Arena 收藏和六项资源；不会读取账号或上传。'
print '请保持 Arena 在首页。密码只在此终端输入，不发送给 Codex。'
/usr/bin/sudo -k -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/local/bin/node "$helper_dir/probe.mjs" > "$result_tmp"
read_exit=$?
/usr/local/bin/node --input-type=module - "$result_tmp" "$result_dir/probe-result.json" "$read_exit" <<'JS'
import {readFile,rename} from 'node:fs/promises';
const [input,output,exitCode]=process.argv.slice(2);
try {
 const result=JSON.parse(await readFile(input,'utf8'));
 if (Number(exitCode)!==0 || result.schema!=='MTGA_COLLECTION_PROBE_V1' || !Array.isArray(result.cards)) {
   console.log('读取未成功：'+(result.code ?? 'READER_FAILED'));process.exitCode=1;
 } else {
   await rename(input,output);
   console.log(JSON.stringify({read_at:result.read_at,card_kinds:result.cards.length,total:result.cards.reduce((n,c)=>n+c.qty,0),inventory:result.inventory,content_hash:result.content_hash},null,2));
   console.log('验证结果已保存，请回复 Codex：授权验证完成。');
 }
} catch { console.log('读取未完成，未保存新快照。');process.exitCode=1; }
JS
print "读取进程退出码：$read_exit"
print '按 Enter 关闭。'
read -r
