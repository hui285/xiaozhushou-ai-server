/*
 * XiaoZhuShou AI image recognition backend, Node 20+, zero dependencies.
 * Provider's API key is strictly server-side: NEVER place it in an APK or frontend.
 * Configure in environment variables or a server host's secret manager.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const ENDPOINT = process.env.AI_CHAT_COMPLETIONS_URL || 'https://api.deepseek.com/chat/completions';
const PROVIDER_API_KEY = process.env.AI_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'deepseek-flash';
const APP_TOKEN = process.env.APP_ACCESS_TOKEN || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://appassets.androidplatform.net')
  .split(',').map(v => v.trim()).filter(Boolean);
const MAX_REQUEST_BYTES = 3_700_000;
const MODEL_TIMEOUT_MS = 42_000;
const rate = new Map();
const MAX_REQUESTS_PER_MIN = 10;
const BIND_HOST = process.env.HOST || '0.0.0.0';

function json(res, code, payload, origin = '') {
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}
function authorized(given) {
  if (!APP_TOKEN || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(APP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function numeric(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
}
function parseModelText(content) {
  let text = typeof content === 'string' ? content : '';
  if (Array.isArray(content)) text = content.map(x => x?.text || '').join('\n');
  if (!text) throw new Error('模型未返回文字或 JSON');
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); }
  catch (_) {
    const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('模型返回内容不是 JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
function normalizeResult(value, mode) {
  if (!value || typeof value !== 'object') throw new Error('营养结果格式不正确');
  const source = value.source_type === 'label' ? 'label' : 'meal';
  const basis = value.basis === 'per100g' ? 'per100g' : 'serving';
  const grams = numeric(value.serving_grams, 10000);
  const base = value.nutrients || {};
  const out = {};
  for (const [key, max] of [['kcal',24000], ['protein',10000], ['carbs',10000], ['fat',10000]]) {
    const n = numeric(base[key], max);
    out[key] = basis === 'per100g' ? (n !== null && grams !== null
      ? Math.round(n * grams / 100 * 100) / 100 : null) : n;
  }
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.slice(0,4).map(x => String(x).slice(0,160)) : [];
  if (source === 'meal' && !warnings.some(w => w.includes('估算')))
    warnings.unshift('普通饭菜营养数据属于图片估算，份量、油和调味料可能导致较大误差。');
  if (basis === 'per100g' && grams === null)
    warnings.unshift('只识别到了每100g营养值，未能确认本次实际食用重量，请手动填写。');
  if (mode === 'label' && source !== 'label')
    warnings.unshift('未识别到完整营养标签，结果为估算，不可视为标签数值。');
  return {
    food_name: String(value.food_name || '').slice(0,60),
    source_type: source,
    serving_grams: grams,
    confidence: String(value.confidence || 'unknown').slice(0,30),
    nutrients: out,
    warnings
  };
}
const prompt = `你是食品营养标签提取与饮食估算助手。只能依据图片与用户补充信息回答，不要编造包装品牌及标签中不可见的具体数值。返回单个 JSON 对象，不能有 Markdown 或额外解释。
字段：food_name（中文名称），source_type（"label" 为确实看清营养成分表，其他为 "meal"），basis（"per100g" 或 "serving"），serving_grams（本次实际摄入克数；未知写 null），confidence（"high"|"medium"|"low"），nutrients（含 kcal,protein,carbs,fat，数字或 null），warnings（字符串数组）。
规则：
- 包装营养标签：清楚看见每100g营养及实际食用净重量时，basis="per100g"，nutrients写每100g值，serving_grams写实际吃掉的克数。服务器将乘以 serving_grams / 100。
- 标签是每份营养时，且确认实际吃了一份：basis="serving"，nutrients写每次摄入总量。
- 能量如果标签为 kJ，请用 1 kcal = 4.184 kJ 换算；不要将 kJ 当 kcal。
- 包装净含量或吃了多少不清楚时用 null，不要猜测；关键数值看不清时写 null。
- 普通饭菜：source_type="meal"，basis="serving"，估算本次摄入营养并在 warnings 明确说明估算与份量不确定性。
- 不要给出任何健康诊断或减肥指导。`;
function isRateLimited(req) {
  const ip = (req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const stats = rate.get(ip);
  if (!stats || now > stats.until) { rate.set(ip, {count:1,until:now+60_000}); return false; }
  stats.count++;
  return stats.count > MAX_REQUESTS_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [key,v] of rate) if (now > v.until) rate.delete(key);
},60_000).unref();

export const server = http.createServer(async (req,res) => {
  const origin = req.headers.origin || '';
  // CORS only for this app, other origins are rejected. Native clients may omit Origin.
  if (origin && !ORIGINS.includes(origin)) { json(res,403,{error:'来源未获授权'});return; }
  if (req.method === 'OPTIONS') {
    if (!origin || !ORIGINS.includes(origin)){json(res,403,{error:'CORS 拒绝'});return;}
    res.writeHead(204,{'Access-Control-Allow-Origin':origin,
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, X-App-Access-Token',
      'Access-Control-Max-Age':'600','Vary':'Origin'});res.end();return;
  }
  if (req.url === '/health' && req.method === 'GET') {
    if (!authorized(req.headers['x-app-access-token'])) {json(res,401,{error:'访问口令不正确'},origin);return;}
    json(res,200,{status:'ok'},origin);return;
  }
  if (req.url !== '/api/recognize' || req.method !== 'POST') {
    json(res,404,{error:'找不到接口'},origin);return;
  }
  if (!authorized(req.headers['x-app-access-token'])){json(res,401,{error:'访问口令不正确'},origin);return;}
  if (isRateLimited(req)){json(res,429,{error:'请求过于频繁，请稍后重试'},origin);return;}
  if (!PROVIDER_API_KEY){
    json(res,503,{error:'服务端尚未配置模型地址、API Key 或模型名称'},origin);return;
  }
  try {
    const endpoint = new URL(ENDPOINT);
    if (endpoint.protocol !== 'https:') throw new Error('模型接口必须是 HTTPS 地址');
    if (!(req.headers['content-type'] || '').includes('application/json')) throw new Error('仅支持 JSON 请求');
    const parts = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) throw new Error('图片过大（上限约 3.7MB）');
      parts.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const image = data.image_base64;
    if (typeof image !== 'string' || image.length > 3_500_000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error('图片格式不正确');
    const mode = data.mode === 'meal' ? 'meal' : 'label';
    const note = typeof data.note === 'string' ? data.note.slice(0,150) : '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),MODEL_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${PROVIDER_API_KEY}`},
        body:JSON.stringify({
          model:MODEL,
          messages:[
            {role:'system',content:prompt},
            {role:'user',content:[
              {type:'text',text:`识别模式：${mode === 'meal'?'普通饭菜':'营养标签'}。用户说明：${note||'无'}。请严格按规则返回 JSON。`},
              {type:'image_url',image_url:{url:image,detail:'auto'}}
            ]}
          ]
        }),
        signal:controller.signal
      });
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      // Do not forward provider raw error or secrets to app.
      json(res,502,{error:`模型服务请求失败（HTTP ${response.status}），请检查模型接口和配额`},origin);return;
    }
    const upstream = await response.json();
    const content = upstream?.choices?.[0]?.message?.content;
    const parsed = parseModelText(content);
    json(res,200,normalizeResult(parsed,mode),origin);
  } catch (e) {
    const msg = e?.name === 'AbortError' ? '模型请求超时' : String(e?.message || '识别失败');
    json(res,400,{error:msg.slice(0,160)},origin);
  }
});

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT,BIND_HOST,() => {
    console.log(`XiaoZhuShou AI proxy listening at ${BIND_HOST}:${PORT}`);
    console.log('Never expose AI_API_KEY in mobile app; use HTTPS at hosting ingress.');
  });
}
