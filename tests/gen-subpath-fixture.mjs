// One-shot generator: freeze the QTS red camera sub-paths (pre-grouping, normalized)
// from QTS_1page.pdf into fixtures/qts-cameras-subpaths.json. Run when the extraction
// or source PDF changes; the routine gate (test-geometry.mjs) reads the frozen output.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const O = pdfjs.OPS;
import { readFileSync, writeFileSync } from "node:fs";

const apply=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
const mul=(A,B)=>[A[0]*B[0]+A[2]*B[1],A[1]*B[0]+A[3]*B[1],A[0]*B[2]+A[2]*B[3],A[1]*B[2]+A[3]*B[3],A[0]*B[4]+A[2]*B[5]+A[4],A[1]*B[4]+A[3]*B[5]+A[5]];
const cubic=(p0,p1,p2,p3,n=12)=>{const o=[];for(let i=1;i<=n;i++){const t=i/n,u=1-t;o.push([u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0],u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]]);}return o;};
function extract(fnArray,argsArray){
  let ctm=[1,0,0,1,0,0];const stack=[];let fill=[0,0,0];let cur=[];let pt=null;const out=[];
  const startSub=(x,y)=>{cur.push({points:[[x,y]]});pt=[x,y];};
  const lineTo=(x,y)=>{if(!cur.length)startSub(x,y);else{cur[cur.length-1].points.push([x,y]);pt=[x,y];}};
  const flush=f=>{if(f)for(const sp of cur)if(sp.points.length>=2)out.push({points:sp.points,closed:true,filled:true,fill_rgb:fill.slice()});cur=[];pt=null;};
  for(let i=0;i<fnArray.length;i++){const fn=fnArray[i],a=argsArray[i];switch(fn){
    case O.save:stack.push(ctm.slice());break;
    case O.restore:if(stack.length)ctm=stack.pop();break;
    case O.transform:ctm=mul(ctm,[a[0],a[1],a[2],a[3],a[4],a[5]]);break;
    case O.setFillRGBColor:fill=[a[0],a[1],a[2]];break;
    case O.setFillGray:fill=[Math.round(a[0]*255),Math.round(a[0]*255),Math.round(a[0]*255)];break;
    case O.setFillCMYKColor:{const[c,m,y,k]=a;fill=[255*(1-c)*(1-k),255*(1-m)*(1-k),255*(1-y)*(1-k)].map(Math.round);break;}
    case O.constructPath:{const ops=a[0],co=a[1];let j=0;for(const op of ops){
      if(op===O.moveTo){const[x,y]=apply(ctm,co[j++],co[j++]);startSub(x,y);}
      else if(op===O.lineTo){const[x,y]=apply(ctm,co[j++],co[j++]);lineTo(x,y);}
      else if(op===O.curveTo){const c1=apply(ctm,co[j++],co[j++]),c2=apply(ctm,co[j++],co[j++]),e=apply(ctm,co[j++],co[j++]);if(pt)for(const p of cubic(pt,c1,c2,e))lineTo(p[0],p[1]);else lineTo(e[0],e[1]);}
      else if(op===O.curveTo2){const c2=apply(ctm,co[j++],co[j++]),e=apply(ctm,co[j++],co[j++]);if(pt)for(const p of cubic(pt,pt,c2,e))lineTo(p[0],p[1]);else lineTo(e[0],e[1]);}
      else if(op===O.curveTo3){const c1=apply(ctm,co[j++],co[j++]),e=apply(ctm,co[j++],co[j++]);if(pt)for(const p of cubic(pt,c1,e,e))lineTo(p[0],p[1]);else lineTo(e[0],e[1]);}
      else if(op===O.rectangle){const x=co[j++],y=co[j++],w=co[j++],h=co[j++];const c=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([px,py])=>apply(ctm,px,py));cur.push({points:[...c,c[0]]});pt=c[c.length-1];}
      else if(op===O.closePath){if(cur.length){const p=cur[cur.length-1].points;if(p.length)p.push(p[0].slice());}}
    }break;}
    case O.fill:case O.eoFill:case O.fillStroke:case O.eoFillStroke:case O.closeFillStroke:flush(true);break;
    case O.stroke:case O.closeStroke:flush(false);break;
    case O.endPath:cur=[];pt=null;break;
  }}return out;
}
const data=new Uint8Array(readFileSync("public/tools/QTS_1page.pdf"));
const doc=await pdfjs.getDocument({data,disableWorker:true,isEvalSupported:false}).promise;
const page=await doc.getPage(1);
const vp=page.getViewport({scale:1.0});
const {fnArray,argsArray}=await page.getOperatorList();
const tc=await page.getTextContent({includeMarkedContent:false});
const raw=[];for(const it of tc.items){const s=(it.str||'').trim().replace(/[^\x20-\x7E]/g,'').trim();if(!s)continue;const tx=it.transform[4],ty=it.transform[5],fs=Math.abs(it.transform[3]);raw.push({cx:tx+(it.width||0)/2,cy:ty+(it.height||fs)/2});}
const xs=raw.map(r=>r.cx),ys=raw.map(r=>r.cy);
const xMin=Math.min(...xs),xMax=Math.max(...xs),yMin=Math.min(...ys),yMax=Math.max(...ys);
const cW=Math.max(xMax-xMin,vp.width),cH=Math.max(yMax-yMin,vp.height);
const norm=(x,y)=>[+((x-xMin)/cW).toFixed(4),+(1-(y-yMin)/cH).toFixed(4)];
let subs=extract(fnArray,argsArray).map(s=>({points:s.points.map(([x,y])=>norm(x,y)),closed:true,filled:true,fill_rgb:s.fill_rgb}));
const target=[255,87,87],tol=48;
subs=subs.filter(s=>s.fill_rgb.every((v,i)=>Math.abs(v-target[i])<=tol));
const out={source:"QTS_1page.pdf p1", fill_target:target, fill_tol:tol,
  frame:{xMin:+xMin.toFixed(3),yMin:+yMin.toFixed(3),cW:+cW.toFixed(3),cH:+cH.toFixed(3),vpW:+vp.width.toFixed(1),vpH:+vp.height.toFixed(1)},
  n_subpaths:subs.length, subpaths:subs};
writeFileSync("fixtures/qts-cameras-subpaths.json", JSON.stringify(out));
console.log("wrote fixtures/qts-cameras-subpaths.json  n_subpaths =", subs.length, " frame cW/cH =", out.frame.cW, out.frame.cH);
