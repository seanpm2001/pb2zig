async function v(){return w("getKernelInfo")}async function y(e,n,s={},t={}){return k(e,n,0,n,s,t)}async function k(e,n,s,t,r={},c={}){const o=[],p=[e,n,s,t,r,c];if("data"in r&&"width"in r&&"height"in r)o.push(r.data.buffer);else for(const m of Object.values(r))o.push(m.data.buffer);return w("createPartialImageData",p,o)}function D(e){if(g=e.keepAlive,a=e.maxCount,!g)i.splice(0);else{const n=i.length+l.length-a;n>0&&i.splice(0,n)}}function W(){d.splice(0)}const b=new URL("bumpmap-worker.js-c7173ae3.js",import.meta.url).href;let g=!0,a=navigator.hardwareConcurrency;const l=[],i=[],d=[],f=[];let j=1;async function x(){let e=i.shift();if(!e){if(a<1)throw new Error(`Unable to start worker because maxCount is ${a}`);if(l.length<a)e=new Worker(b,{type:"module"}),e.onmessage=I,e.onerror=n=>console.error(n);else return new Promise(n=>{d.push(n)})}return l.push(e),e}async function w(e,n=[],s=[]){const t=await x(),r={id:j++,promise:null,resolve:null,reject:null,worker:t};return r.promise=new Promise((c,o)=>{r.resolve=c,r.reject=o}),f.push(r),t.onmessageerror=()=>reject(new Error("Message error")),t.postMessage([e,r.id,...n],{transfer:s}),r.promise}function I(e){const[n,s,t]=e.data,r=f.findIndex(u=>u.id===s),c=f[r];f.splice(r,1);const{worker:o,resolve:p,reject:m}=c;n!=="error"?p(t):m(t);const h=d.shift();if(h)h(o);else{const u=l.indexOf(o);u!==-1&&l.splice(u,1),g&&i.length<a&&i.push(o)}}export{y as createImageData,k as createPartialImageData,v as getKernelInfo,D as manageWorkers,W as purgeQueue};
