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

if(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD==="CHANGE_THIS_TO_YOUR_PRIVATE_PASSWORD")
 console.warn("WARNING: Set ADMIN_PASSWORD in .env before production use.");

app.use(express.json({limit:"30mb"}));
app.use(session({
 secret:process.env.SESSION_SECRET||"dev-secret-change-me",
 resave:false,saveUninitialized:false,
 cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:24*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));

function adminOnly(req,res,next){if(req.session.admin)return next();res.status(401).json({error:"Unauthorized"})}
app.post("/admin/login",(req,res)=>{
 const ok=typeof req.body.password==="string"&&req.body.password===process.env.ADMIN_PASSWORD;
 if(!ok)return res.status(401).json({error:"Wrong password"});
 req.session.admin=true;res.json({ok:true});
});
app.post("/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/admin/messages",adminOnly,(req,res)=>res.json(readMessages().sort((a,b)=>b.id-a.id)));

let nextId=readMessages().reduce((m,x)=>Math.max(m,Number(x.id)||0),0)+1;
io.on("connection",socket=>{
 socket.on("join-room",({room,sender,senderId})=>{
   room=String(room||"").trim().toUpperCase();sender=String(sender||"Guest").slice(0,30);senderId=String(senderId||"").slice(0,80);
   if(room.length<4||room.length>80)return socket.emit("join-error","Invalid code.");
   socket.data.room=room;socket.data.sender=sender;socket.data.senderId=senderId;socket.join(room);
   socket.emit("history",readMessages().filter(x=>x.room===room).slice(-200));
   io.to(room).emit("presence",{online:io.sockets.adapter.rooms.get(room)?.size||1});
 });
 socket.on("message",m=>{
   const room=socket.data.room,sender=socket.data.sender,senderId=socket.data.senderId;
   if(!room||!m||!["text","image","video"].includes(m.type))return;
   const item={id:nextId++,room,sender,senderId,type:m.type,
     text:typeof m.text==="string"?m.text.slice(0,5000):null,
     data_url:typeof m.data_url==="string"?m.data_url:null,
     created_at:new Date().toISOString()};
   const all=readMessages();all.push(item);writeMessages(all);
   io.to(room).emit("message",item);
 });
 socket.on("typing",()=>{if(socket.data.room)socket.to(socket.data.room).emit("typing")});
 socket.on("disconnect",()=>{if(socket.data.room)io.to(socket.data.room).emit("presence",{online:io.sockets.adapter.rooms.get(socket.data.room)?.size||0})});
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Secret Chats running on http://localhost:${PORT}`));