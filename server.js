require("dotenv").config();
const express=require("express");
const http=require("http");
const path=require("path");
const fs=require("fs");
const session=require("express-session");
const {Server}=require("socket.io");

const app=express(), server=http.createServer(app), io=new Server(server,{maxHttpBufferSize:25*1024*1024});
const DB=path.join(__dirname,"messages.json");
if(!fs.existsSync(DB)) fs.writeFileSync(DB,"[]","utf8");
function readMessages(){try{return JSON.parse(fs.readFileSync(DB,"utf8")||"[]")}catch{return[]}}
function writeMessages(a){fs.writeFileSync(DB,JSON.stringify(a),"utf8")}
if(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD==="CHANGE_THIS_TO_YOUR_PRIVATE_PASSWORD") console.warn("WARNING: Set ADMIN_PASSWORD in .env before production use.");
app.use(express.json({limit:"30mb"}));
app.use((req,res,next)=>{if(req.path==="/"||req.path.endsWith(".html")){res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.set("Pragma","no-cache");res.set("Expires","0")}next()});
app.use(session({secret:process.env.SESSION_SECRET||"dev-secret-change-me",resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:24*60*60*1000}}));
app.use((req,res,next)=>{
  if(req.path==="/" || req.path.endsWith(".html") || req.path==="/sw.js"){
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Expires","0");
  }
  next();
});
app.use(express.static(path.join(__dirname,"public"),{etag:false,lastModified:false}));
function adminOnly(req,res,next){if(req.session.admin)return next();res.status(401).json({error:"Unauthorized"})}
app.post("/admin/login",(req,res)=>{const ok=typeof req.body.password==="string"&&req.body.password===process.env.ADMIN_PASSWORD;if(!ok)return res.status(401).json({error:"Wrong password"});req.session.admin=true;res.json({ok:true})});
app.post("/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/admin/messages",adminOnly,(req,res)=>res.json(readMessages().sort((a,b)=>b.id-a.id)));

let nextId=readMessages().reduce((m,x)=>Math.max(m,Number(x.id)||0),0)+1;
function roomOnline(room){return io.sockets.adapter.rooms.get(room)?.size||0}
function broadcastPresence(room){io.to(room).emit("presence",{online:roomOnline(room)})}
function markDelivered(room,recipientId){const all=readMessages();let changed=false;for(const m of all){if(m.room===room&&m.senderId!==recipientId&&m.status!=="read"){m.status="delivered";changed=true}}if(changed)writeMessages(all);io.to(room).emit("statuses-updated",{by:recipientId,status:"delivered"})}
function markRead(room,readerId){const all=readMessages();let changed=false;for(const m of all){if(m.room===room&&m.senderId!==readerId&&m.status!=="read"){m.status="read";changed=true}}if(changed)writeMessages(all);if(changed)io.to(room).emit("statuses-updated",{by:readerId,status:"read"})}

io.on("connection",socket=>{
 socket.on("join-room",({room,sender,senderId})=>{
   room=String(room||"").trim().toUpperCase();sender=String(sender||"Guest").slice(0,30);senderId=String(senderId||"").slice(0,80);
   if(room.length<4||room.length>80)return socket.emit("join-error","Invalid code.");
   socket.data.room=room;socket.data.sender=sender;socket.data.senderId=senderId;socket.join(room);
   const history=readMessages().filter(x=>x.room===room).slice(-200);socket.emit("history",history);
   markDelivered(room,senderId);markRead(room,senderId);broadcastPresence(room);
 });
 socket.on("message",m=>{
   const room=socket.data.room,sender=socket.data.sender,senderId=socket.data.senderId;
   if(!room||!m||!["text","image","video","gif"].includes(m.type))return;
   const item={id:nextId++,room,sender,senderId,type:m.type,text:typeof m.text==="string"?m.text.slice(0,5000):null,data_url:typeof m.data_url==="string"?m.data_url:null,created_at:new Date().toISOString(),status:"sent",replyTo:m.replyTo?{id:Number(m.replyTo.id),sender:String(m.replyTo.sender||"").slice(0,30),text:String(m.replyTo.text||"").slice(0,180),type:String(m.replyTo.type||"text")} : null,starred:false,pinned:false,reactions:{} };
   const all=readMessages();all.push(item);writeMessages(all);io.to(room).emit("message",item);
   if(roomOnline(room)>1){item.status="delivered";const saved=readMessages();const idx=saved.findIndex(x=>x.id===item.id);if(idx>=0){saved[idx].status="delivered";writeMessages(saved)}io.to(room).emit("statuses-updated",{ids:[item.id],status:"delivered"})}
 });
 socket.on("typing",()=>{if(!socket.data.room)return;const now=Date.now();if(socket.data.lastTyping&&now-socket.data.lastTyping<700)return;socket.data.lastTyping=now;socket.to(socket.data.room).emit("typing",{sender:socket.data.sender})});
 socket.on("activity-status",({status}={})=>{if(!socket.data.room)return;const allowed=["active","idle"];if(!allowed.includes(status))return;socket.to(socket.data.room).emit("activity-status",{sender:socket.data.sender,status})});
 socket.on("toggle-reaction",({id,emoji}={})=>{const all=readMessages(),m=all.find(x=>x.id===Number(id)&&x.room===socket.data.room);if(!m||typeof emoji!=="string"||!emoji.trim()||emoji.length>12)return;emoji=emoji.trim();m.reactions=m.reactions&&typeof m.reactions==="object"?m.reactions:{};m.reactions[emoji]=Array.isArray(m.reactions[emoji])?m.reactions[emoji]:[];const list=m.reactions[emoji],i=list.indexOf(socket.data.senderId);if(i>=0)list.splice(i,1);else list.push(socket.data.senderId);if(!list.length)delete m.reactions[emoji];writeMessages(all);io.to(m.room).emit("reaction-updated",{id:m.id,reactions:m.reactions})});
 socket.on("read-room",()=>{if(socket.data.room&&socket.data.senderId)markRead(socket.data.room,socket.data.senderId)});
 socket.on("quality-ping",ack=>{if(typeof ack==="function")ack()});
 socket.on("toggle-star",({id})=>{const all=readMessages(),m=all.find(x=>x.id===Number(id)&&x.room===socket.data.room);if(!m)return;m.starred=!m.starred;writeMessages(all);io.to(m.room).emit("message-meta",{id:m.id,starred:m.starred,pinned:m.pinned})});
 socket.on("toggle-pin",({id})=>{const all=readMessages(),m=all.find(x=>x.id===Number(id)&&x.room===socket.data.room);if(!m)return;m.pinned=!m.pinned;writeMessages(all);io.to(m.room).emit("message-meta",{id:m.id,starred:m.starred,pinned:m.pinned})});
 socket.on("delete-for-everyone",({id})=>{const all=readMessages(),idx=all.findIndex(x=>x.id===Number(id)&&x.room===socket.data.room);if(idx<0)return;const m=all[idx];if(m.senderId!==socket.data.senderId)return;all[idx]={...m,type:"deleted",text:"This message was deleted",data_url:null,replyTo:null};writeMessages(all);io.to(m.room).emit("message-deleted",{id:m.id})});
 socket.on("disconnect",()=>{if(socket.data.room)broadcastPresence(socket.data.room)});
});
const PORT=process.env.PORT||3000;server.listen(PORT,"0.0.0.0",()=>console.log(`Secret Chats running on port ${PORT}`));
