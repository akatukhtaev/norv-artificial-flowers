export default {
 async fetch(request, env) {
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8",...cors}});
  if(method==="OPTIONS")return new Response(null,{headers:cors});
  try{
   if(path==="/api/products"&&method==="GET"){const {results}=await env.DB.prepare("SELECT * FROM products ORDER BY created_at DESC").all();return json({products:results.map(r=>({...r,types:JSON.parse(r.types||'[]')}))})}
   if(path==="/api/login"&&method==="POST"){const {password}=await request.json();if(!env.ADMIN_PASSWORD||password!==env.ADMIN_PASSWORD)return json({error:"Неверный пароль"},401);return json({token:await signToken(env.ADMIN_PASSWORD,Date.now()+8*60*60*1000,env.SESSION_SECRET)})}
   if(path.startsWith("/api/products")&&method!=="GET"){
    if(!await authorized(request,env))return json({error:"Требуется вход администратора"},401);
    if(path==="/api/products"&&method==="POST"){const p=await request.json();validate(p);const res=await env.DB.prepare("INSERT INTO products (name,sku,category,price,packPrice,packQty,bulkPrice,bulkMin,stock,unit,description,image,badge,types,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(p.name,p.sku||"",p.category||"",p.price,p.packPrice||0,p.packQty||1,p.bulkPrice||0,p.bulkMin||50,p.stock||0,p.unit||"шт.",p.description||"",p.image||"",p.badge||"",JSON.stringify(p.types||["piece","pack","bulk"]),Date.now()).run();return json({id:res.meta.last_row_id},201)}
    const id=Number(path.split("/").pop());if(!Number.isInteger(id))return json({error:"Некорректный ID"},400);
    if(method==="PUT"){const p=await request.json();validate(p);await env.DB.prepare("UPDATE products SET name=?,sku=?,category=?,price=?,packPrice=?,packQty=?,bulkPrice=?,bulkMin=?,stock=?,unit=?,description=?,image=?,badge=?,types=? WHERE id=?").bind(p.name,p.sku||"",p.category||"",p.price,p.packPrice||0,p.packQty||1,p.bulkPrice||0,p.bulkMin||50,p.stock||0,p.unit||"шт.",p.description||"",p.image||"",p.badge||"",JSON.stringify(p.types||[]),id).run();return json({ok:true})}
    if(method==="DELETE"){await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();return json({ok:true})}
   }
   return json({error:"Not found"},404)
  }catch(e){return json({error:e.message||"Server error"},500)}
 }
};
function validate(p){if(!p||typeof p.name!=="string"||!p.name.trim()||!Number.isFinite(Number(p.price))||Number(p.price)<0)throw Error("Укажите название и корректную розничную цену")}
async function signToken(password,expiry,secret){const data=expiry+"."+btoa(password),key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret||password),{name:"HMAC",hash:"SHA-256"},false,["sign"]),sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(data));return btoa(data)+"."+btoa(String.fromCharCode(...new Uint8Array(sig)))}
async function authorized(req,env){try{const token=(req.headers.get("Authorization")||"").replace("Bearer ",""),[payload,sig]=token.split("."),data=atob(payload),[expiry]=data.split(".");if(Number(expiry)<Date.now())return false;const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.SESSION_SECRET||env.ADMIN_PASSWORD),{name:"HMAC",hash:"SHA-256"},false,["verify"]),raw=Uint8Array.from(atob(sig),c=>c.charCodeAt(0));return crypto.subtle.verify("HMAC",key,raw,new TextEncoder().encode(data))}catch{return false}}
