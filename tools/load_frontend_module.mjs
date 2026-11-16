/** 用本地 TypeScript 加载纯函数模块，测试不依赖浏览器或项目构建。 */
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(new URL('../frontend/package.json',import.meta.url))
const ts=require('typescript'), cache=new Map()
export function loadFrontend(name) {
  if(cache.has(name))return cache.get(name)
  if(!/^[A-Za-z][A-Za-z0-9]*$/.test(name))throw new Error('Invalid pure module name')
  const exports={};cache.set(name,exports)
  const code=ts.transpileModule(readFileSync(new URL(`../frontend/src/${name==='types'?'':'lib/'}${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
  vm.runInNewContext(code,{exports,console,require:id=>{if(id==='../types')return loadFrontend('types');if(!id.startsWith('./'))throw new Error('Pure module has external dependency');return loadFrontend(id.slice(2))}},{filename:name+'.ts'})
  return exports
}
