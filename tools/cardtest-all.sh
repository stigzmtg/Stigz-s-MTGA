#!/bin/sh
# Run the per-card smoke test across N parallel shards and merge results.
N=${1:-8}
OUT=${2:-/tmp/cardtest}
mkdir -p "$OUT"
i=0
while [ $i -lt $N ]; do
  node tools/cardtest.mjs --shard=$i/$N --out="$OUT/shard$i.json" > "$OUT/shard$i.log" 2>&1 &
  i=$((i+1))
done
wait
node -e '
const fs=require("fs"); const dir=process.argv[1]; let total=0, failed=[], uns=[], props=new Set(), defs=new Set();
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith(".json"))) { const j=JSON.parse(fs.readFileSync(dir+"/"+f)); total+=j.summary.total; failed.push(...j.failed); uns.push(...j.unsupported); j.summary.unknownProps.forEach(p=>props.add(p)); j.summary.unknownDefined.forEach(p=>defs.add(p)); }
fs.writeFileSync(dir+"/merged.json", JSON.stringify({total, failed, uns, props:[...props], defs:[...defs]}, null, 1));
console.log("total", total, "failed", failed.length, "with unsupported", uns.length);
const em={}; for (const f of failed) { const k=(f.errors[0]||"").split(" | ").slice(0,2).join(" | ").slice(0,200); (em[k]=em[k]||[]).push(f.name); }
for (const [k,v] of Object.entries(em).sort((a,b)=>b[1].length-a[1].length).slice(0,40)) console.log(v.length, k, "::", v.slice(0,4).join("; "));
console.log("unknown props:", [...props].join(", "));
console.log("unknown defined:", [...defs].join(", "));
' "$OUT"
