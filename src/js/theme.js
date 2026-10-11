(function(){
  var r=document.documentElement,k='qwz-theme',t='dark';
  try{t=localStorage.getItem(k)||'dark';}catch(e){}
  r.dataset.theme=t;
  document.addEventListener('DOMContentLoaded',function(){
    var b=document.getElementById('theme-toggle');
    b.onclick=function(){t=t==='dark'?'light':'dark';r.dataset.theme=t;try{localStorage.setItem(k,t);}catch(e){}};
  });
})();
