async function v(){return h("getKernelInfo")}async function y(e,r,t={},o={}){return k(e,r,0,r,t,o)}async function k(e,r,t,o,n={},c={}){const s=[],p=[e,r,t,o,n,c];if("data"in n&&"width"in n&&"height"in n)s.push(n.data.buffer);else for(const m of Object.values(n))s.push(m.data.buffer);return h("createPartialImageData",p,s)}function C(e){if("keepAlive"in e&&(d=e.keepAlive,d||i.splice(0)),"maxCount"in e){a=e.maxCount;const r=i.length+l.length-a;r>0&&i.splice(0,r)}}function P(){w.splice(0)}const b=new URL("color-burn-worker-9499ff86.js",import.meta.url).href;let d=!0,a=navigator.hardwareConcurrency;const l=[],i=[],w=[],f=[];let x=1;async function j(){let e=i.shift();if(!e){if(a<1)throw new Error(`Unable to start worker because maxCount is ${a}`);if(l.length<a)e=new Worker(b,{type:"module"}),await new Promise((r,t)=>{e.onmessage=r,e.onerror=t}),e.onmessage=I,e.onerror=r=>console.error(r);else return new Promise(r=>w.push(r))}return l.push(e),e}async function h(e,r=[],t=[]){const o=await j(),n={id:x++,promise:null,resolve:null,reject:null,worker:o};return n.promise=new Promise((c,s)=>{n.resolve=c,n.reject=s}),f.push(n),o.onmessageerror=()=>reject(new Error("Message error")),o.postMessage([e,n.id,...r],{transfer:t}),n.promise}function I(e){const[r,t,o]=e.data,n=f.findIndex(u=>u.id===t),c=f[n];f.splice(n,1);const{worker:s,resolve:p,reject:m}=c;r!=="error"?p(o):m(o);const g=w.shift();if(g)g(s);else{const u=l.indexOf(s);u!==-1&&l.splice(u,1),d&&i.length<a&&i.push(s)}}export{y as createImageData,k as createPartialImageData,v as getKernelInfo,C as manageWorkers,P as purgeQueue};
