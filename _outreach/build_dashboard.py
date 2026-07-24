#!/usr/bin/env python3
"""
Builds a local admin dashboard (dashboard.html) from leads.csv. Data is baked
into the file so it opens straight in a browser, no server, no cloud, no DB.
Re-run after each pull/mail to refresh.  ->  python build_dashboard.py
"""
import os, csv, json

HERE = os.path.dirname(os.path.abspath(__file__))
LEADS = os.path.join(HERE, "leads.csv")
OUT = os.path.join(HERE, "dashboard.html")

rows = list(csv.DictReader(open(LEADS, encoding="utf-8")))
for r in rows:
    r["address"] = " ".join(x for x in [r.get("street", ""), r.get("city", ""), r.get("state", ""), r.get("zip", "")] if x)

data = json.dumps(rows)

html = """<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KILLSWITCH · Outreach Dashboard</title>
<style>
  :root{--bg:#121214;--panel:#1a1a1e;--metal:#232328;--line:#34343c;--ink:#fff;--mute:#b6bac2;--mute2:#888c96;--amber:#FFC42E;--red:#FF5546;--go:#1BA45A}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:"Segoe UI",system-ui,Arial,sans-serif;line-height:1.5;padding:26px 22px 60px}
  h1{font-size:1.5rem;font-weight:800;letter-spacing:-.01em}
  .sub{color:var(--mute2);font-size:.85rem;margin-top:4px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:22px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:120px}
  .card .k{font-size:1.7rem;font-weight:800;font-variant-numeric:tabular-nums}
  .card .l{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--mute2);margin-top:2px}
  .card.amber .k{color:var(--amber)} .card.go .k{color:var(--go)} .card.red .k{color:var(--red)}
  .bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 16px}
  select,input{background:var(--metal);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font:inherit;font-size:.9rem}
  input{min-width:220px}
  .count{color:var(--mute2);font-size:.85rem;margin-left:auto}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
  th{color:var(--mute2);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg)}
  th:hover{color:var(--ink)}
  tr:hover td{background:var(--panel)}
  td.name{font-weight:600}
  .pill{font-size:.68rem;font-weight:700;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
  .pill.new{background:rgba(255,196,46,.14);color:var(--amber)}
  .pill.mailed{background:rgba(27,164,90,.16);color:var(--go)}
  .pill.bad_address{background:rgba(255,85,70,.16);color:var(--red)}
  .pill.called{background:rgba(120,150,255,.16);color:#9db0ff}
  a{color:var(--amber)}
  .wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
</style></head><body>
  <h1>Outreach Dashboard <span style="color:var(--red)">·</span></h1>
  <div class="sub">Local view of leads.csv. Re-run build_dashboard.py after a pull or mail to refresh.</div>
  <div class="cards" id="cards"></div>
  <div class="bar">
    <input id="q" placeholder="Search business name...">
    <select id="fTrade"><option value="">All trades</option></select>
    <select id="fState"><option value="">All states</option></select>
    <select id="fStatus"><option value="">All statuses</option></select>
    <span class="count" id="count"></span>
  </div>
  <div class="wrap"><table><thead><tr>
    <th data-k="trade">Trade</th><th data-k="name">Business</th><th data-k="phone">Phone</th>
    <th data-k="address">Address</th><th data-k="status">Status</th>
  </tr></thead><tbody id="tb"></tbody></table></div>
<script>
const DATA = __DATA__;
const $=id=>document.getElementById(id);
let sortK="trade", sortDir=1;

function uniq(k){return [...new Set(DATA.map(r=>r[k]).filter(Boolean))].sort();}
uniq("trade").forEach(t=>$("fTrade").insertAdjacentHTML("beforeend",`<option>${t}</option>`));
uniq("state").forEach(s=>$("fState").insertAdjacentHTML("beforeend",`<option>${s}</option>`));
uniq("status").forEach(s=>$("fStatus").insertAdjacentHTML("beforeend",`<option>${s}</option>`));

function stats(list){
  const mail=list.filter(r=>r.street&&r.state&&r.zip).length;
  const call=list.filter(r=>r.phone).length;
  const by=s=>list.filter(r=>(r.status||"new")===s).length;
  $("cards").innerHTML=[
    ["",list.length,"Leads"],["amber",mail,"Mailable"],["",call,"Callable"],
    ["go",by("mailed"),"Mailed"],["red",by("bad_address"),"Bad address"],
    ["amber",by("new"),"To do"],
  ].map(([c,k,l])=>`<div class="card ${c}"><div class="k">${k.toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}
function render(){
  let list=DATA.filter(r=>{
    const q=$("q").value.toLowerCase();
    return (!q||r.name.toLowerCase().includes(q))
      && (!$("fTrade").value||r.trade===$("fTrade").value)
      && (!$("fState").value||r.state===$("fState").value)
      && (!$("fStatus").value||(r.status||"new")===$("fStatus").value);
  });
  list.sort((a,b)=>String(a[sortK]||"").localeCompare(String(b[sortK]||""))*sortDir);
  $("count").textContent=list.length.toLocaleString()+" shown";
  $("tb").innerHTML=list.map(r=>{
    const st=(r.status||"new");
    const tel=r.phone?`<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>`:"";
    return `<tr><td>${esc(r.trade)}</td><td class="name">${esc(r.name)}</td><td>${tel}</td>
      <td>${esc(r.address)}</td><td><span class="pill ${st}">${st.replace("_"," ")}</span></td></tr>`;
  }).join("");
  stats(list);
}
document.querySelectorAll("th").forEach(th=>th.onclick=()=>{
  const k=th.dataset.k; sortDir=(k===sortK)?-sortDir:1; sortK=k; render();
});
["q","fTrade","fState","fStatus"].forEach(id=>$(id).oninput=render);
render();
</script></body></html>"""

open(OUT, "w", encoding="utf-8").write(html.replace("__DATA__", data))
print(f"wrote {OUT} ({len(rows)} leads). Open it in any browser.")
