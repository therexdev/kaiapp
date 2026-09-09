"use strict";
// Synthetic contract fixtures shaped after Composio's published v3.1 REST docs.
// No real credentials or provider accounts are used by these tests.
const APPS = [
 { slug:"github", name:"GitHub", meta:{description:"Follow repositories, issues and pull requests.",logo:"https://logos.composio.dev/api/github",categories:[{id:"developer-tools",name:"Developer Tools"}]},auth_schemes:["OAUTH2"],composio_managed_auth_schemes:["OAUTH2"] },
 { slug:"gmail", name:"Gmail", meta:{description:"Find messages and keep up with your inbox.",categories:[{id:"email",name:"Email"}]},auth_schemes:["OAUTH2"] },
 { slug:"notion", name:"Notion", meta:{description:"Keep your notes, knowledge and projects close.",categories:[{id:"productivity",name:"Productivity"}]},auth_schemes:["OAUTH2"] }
];
const TOOLS = [
 {slug:"GITHUB_LIST_ISSUES",name:"List repository issues",description:"Read issues from a repository you choose.",toolkit:{slug:"github"},version:"20260901_00",tags:["readOnlyHint"],input_parameters:{type:"object",properties:{owner:{type:"string",title:"Repository owner"},repo:{type:"string",title:"Repository name"},limit:{type:"integer",default:10}},required:["owner","repo"]}},
 {slug:"GITHUB_CREATE_ISSUE",name:"Create an issue",description:"Create an issue in a repository.",toolkit:{slug:"github"},version:"20260901_00",tags:[],input_parameters:{type:"object",properties:{title:{type:"string"}},required:["title"]}},
 {slug:"GMAIL_LIST_MESSAGES",name:"List messages",description:"Read messages.",toolkit:{slug:"gmail"},version:"20260901_00",tags:["readOnlyHint"],input_parameters:{type:"object",properties:{}}}
];
function fixture() {
 const state={calls:[],accounts:[],links:[],executions:[],key:"synthetic-composio-key",withLinkId:true};
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
 state.fetch=async(url,init={})=>{
  const u=new URL(url), p=u.pathname.replace("/api/v3.1", ""), body=init.body?JSON.parse(init.body):{};
  state.calls.push({url,init,body});
  if(u.origin!=="https://backend.composio.dev")throw new Error("Unexpected network destination");
  if(init.headers?.["x-api-key"]!==state.key)return response({error:"Never expose upstream details or keys"},401);
  if(p==="/toolkits/categories")return response({items:[{id:"developer-tools",name:"Developer Tools"},{id:"email",name:"Email"},{id:"productivity",name:"Productivity"}]});
  if(p==="/toolkits")return response({items:APPS.filter(t=>(!u.searchParams.get("category")||t.meta.categories.some(c=>c.id===u.searchParams.get("category")))&&t.name.toLowerCase().includes((u.searchParams.get("search")||"").toLowerCase())),next_cursor:null,total_items:APPS.length});
  if(p.startsWith("/toolkits/"))return response(APPS.find(t=>t.slug===p.split("/").at(-1))||{},APPS.some(t=>t.slug===p.split("/").at(-1))?200:404);
  if(p==="/auth_configs"&&init.method!=="POST")return response({items:[]});
  if(p==="/auth_configs")return response({auth_config:{id:"ac_"+body.toolkit.slug},toolkit:body.toolkit},201);
  if(p==="/connected_accounts/link") {
   const link={id:"ca_"+(state.links.length+1),user_id:body.user_id,toolkit:{slug:body.auth_config_id.slice(3)},status:"INITIATED",alias:"Work account "+(state.links.length+1),state:{access_token:"provider-secret"},data:{refresh_token:"provider-refresh"}};
   state.links.push(link);state.accounts.push(link);return response({redirect_url:"https://connect.composio.dev/link/fixture",...(state.withLinkId?{connected_account_id:link.id}:{}),expires_at:new Date(Date.now()+600000).toISOString()});
  }
  if(p==="/connected_accounts")return response({items:state.accounts,next_cursor:null}); // Deliberately returns other users too.
  if(p.startsWith("/connected_accounts/")){const i=state.accounts.findIndex(a=>a.id===p.split("/").at(-1));if(i<0)return response({},404);if(init.method==="DELETE"){state.accounts.splice(i,1);return response({success:true});}return response(state.accounts[i]);}
  if(p==="/tools")return response({items:TOOLS.filter(t=>t.toolkit.slug===u.searchParams.get("toolkit_slug")&&t.name.toLowerCase().includes((u.searchParams.get("query")||"").toLowerCase())),next_cursor:null});
  if(p.startsWith("/tools/execute/")){state.executions.push(body);return response({successful:true,data:{issues:[{title:"Plan KAI companion",owner:body.arguments.owner}],echo:state.key}});}
  if(p.startsWith("/tools/")){const tool=TOOLS.find(t=>t.slug===p.split("/").at(-1));return response(tool||{},tool?200:404);}
  return response({},404);
 };
 state.authorize=()=>{state.links.at(-1).status="ACTIVE";};return state;
}
module.exports={fixture,APPS,TOOLS};
