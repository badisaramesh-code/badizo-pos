// Express 4 does not observe the Promise returned by an async route handler.
// Observe only terminal handlers, after route registration: an async auth or
// next()-calling middleware finishing does NOT mean the business work ended.
const wrapped=Symbol('badizoRecoveryTerminalCompletion');
function installRecoveryRouteCompletion(app){
  const visited=new Set();let installed=0;
  function visit(router){
    if(!router||visited.has(router))return;visited.add(router);
    for(const layer of router.stack||[]){
      if(layer.route){
        const routeStack=layer.route.stack||[];
        const applicable=method=>routeStack.filter(item=>!item.method||item.method===method).at(-1);
        const methods=new Set(['get','post','put','patch','delete','head','options','connect','trace',...routeStack.map(item=>item.method).filter(Boolean)]);
        const terminal=new Set([...methods].map(applicable).filter(Boolean));
        for(const last of terminal){
          const original=last.handle;
          if(!original||original[wrapped]||original.length===4||original.constructor?.name!=='AsyncFunction')continue;
          const completion=function(req,res,next){
            let forwarded=false,method=req.method.toLowerCase();
            if(method==='head'&&!layer.route.methods.head)method='get';
            const isTerminal=applicable(method)===last;
            const forward=value=>{forwarded=true;return next(value);};
            return Promise.resolve().then(()=>original(req,res,forward)).finally(()=>{if(isTerminal&&!forwarded)req.completeRecoveryWrite?.();}).catch(next);
          };
          completion[wrapped]=true;last.handle=completion;installed++;
        }
      }else if(layer.handle?.stack)visit(layer.handle);
    }
  }
  visit(app._router||app);return installed;
}
module.exports={installRecoveryRouteCompletion};
