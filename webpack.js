const { SyncHook } = require("tapable"); //这是一个同步钩子
const parser = require("@babel/parser");
let types = require("@babel/types");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const path = require("path");
const fs = require("fs");
function getSource(chunk) {
  return `(()=>{
        var modules={
            ${chunk.modules.map(
              (module) => `
            "${module.id}":(module)=>{
                ${module._source}
            }
            `
            )}
        };
        var cache = {};
        function require(moduleId){
            var cacheModule = cache[moduleId];
            if(cacheModule !== undefined){
                return cacheModule.exports
            };
            var module = (cache[moduleId]={
                exports:{}
            });
            modules[moduleId](module,module.exports,require);
            return module.exports;
        }
        var exports = {};
        ${chunk.entryModule._source}
    })()
    `;
}
function toUnixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}
const baseDir = toUnixPath(process.cwd());
function tryExtensions(modulePath, extensions) {
  if (fs.existsSync(modulePath)) {
    return modulePath;
  }
  for (let i = 0; i < extensions?.length; i++) {
    let filePath = modulePath + extensions[i];
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  throw new Error(`无法找到${modulePath}`);
}
class Compiler {
  constructor(webpackConfig) {
    this.config = webpackConfig;
    this.hooks = {
      run: new SyncHook(),
      done: new SyncHook(),
    };
  }
  compile(callback) {
    let compilation = new Compilation(this.config);
    compilation.build(callback);
  }
  run(callback) {
    this.hooks.run.call();
    const onCompiled = (err, stats, fileDependencies) => {
      for (let filename in stats.assets) {
        let filePath = path.join(this.config.output.path, filename);
        fs.writeFileSync(filePath, stats.assets[filename], "utf8");
        callback(err, {
          toJson: () => stats,
        });
      }
      this.hooks.done.call();
    };
    this.compile(onCompiled);
  }
}
class Compilation {
  constructor(options) {
    this.options = options;
    this.modules = [];
    this.chunks = [];
    this.assets = {};
    this.fileDependencies = [];
  }
  buildModule(name, modulePath) {
    let sourceCode = fs.readFileSync(modulePath, "utf8");
    let moduleId = "./" + path.posix.relative(baseDir, modulePath);
    let module = {
      id: moduleId,
      names: [name],
      dependencies: [],
      _source: "",
    };
    let loaders = [];
    let { rules } = this.options.module;
    rules.forEach((rule) => {
      if (modulePath.match(rule.test)) {
        loaders.push(...rule.use);
      }
    });
    sourceCode = loaders.reduceRight((code, loader) => {
      return loader(code);
    }, sourceCode);
    // 通过ast分析require依赖
    let ast = parser.parse(sourceCode, { sourceType: "module" });
    traverse(ast, {
      CallExpression: (nodePath) => {
        const { node } = nodePath;
        if (node.callee.name === "require") {
          let depModuleName = node.arguments[0].value;
          let dirName = path.posix.dirname(modulePath);
          let depModulePath = path.posix.join(dirName, depModuleName);
          let extensions = this.options.resolve?.extensions || [".js"];
          depModulePath = tryExtensions(depModulePath, extensions);
          this.fileDependencies.push(depModulePath);
          let depModuleId = "./" + path.posix.relative(baseDir, depModulePath);
          node.arguments = [types.stringLiteral(depModuleId)];
          module.dependencies.push({ depModuleId, depModulePath });
        }
      },
    });
    let { code } = generator(ast);
    module._source = code;
    module.dependencies.forEach(({ depModuleId, depModulePath }) => {
      let existModule = this.modules.find((id) => id === depModuleId);
      if (existModule) {
        existModule.names.push(name);
      } else {
        let depModule = this.buildModule(name, depModulePath);
        this.modules.push(depModule);
      }
    });
    return module;
  }
  build(callback) {
    let entry = {};
    if (typeof this.options.entry === "string") {
      entry.main = this.options.entry;
    } else {
      entry = this.options.entry;
    }
    for (let entryName in entry) {
      let entryFilePath = path.posix.join(baseDir, entry[entryName]);
      this.fileDependencies.push(entryFilePath);
      let entryModule = this.buildModule(entryName, entryFilePath);
      this.modules.push(entryModule);
      let chunk = {
        name: entryName,
        entryModule,
        modules: this.modules.filter((item) => item.names.includes(entryName)),
      };
      this.chunks.push(chunk);
    }
    this.chunks.forEach((chunk) => {
      let fileName = this.options.output.filename.replace("[name]", chunk.name);
      this.assets[fileName] = getSource(chunk);
      console.log(this.assets[fileName]);
    });
    callback(
      null,
      {
        chunks: this.chunks,
        modules: this.modules,
        assets: this.assets,
      },
      this.fileDependencies
    );
  }
}
class WebpackRunPlugin {
  apply(compiler) {
    compiler.hooks.run.tap("WebpackRunPlugin", () => {
      console.log("自定义runHookPlugin");
    });
  }
}

class WebpackDonePlugin {
  apply(compiler) {
    compiler.hooks.done.tap("WebpackDonePlugin", () => {
      console.log("自定义doneHookPlugin");
    });
  }
}

function webpack(webpackConfig) {
  const compiler = new Compiler(webpackConfig);
  const { plugins } = webpackConfig;
  for (let plugin of plugins) {
    plugin.apply(compiler);
  }
  return compiler;
}

const loader1 = (source) => {
  return source + "//loader1处理过";
};
const loader2 = (source) => {
  return source + "//loader2处理过";
};

module.exports = {
  webpack,
  WebpackDonePlugin,
  WebpackRunPlugin,
  loader1,
  loader2,
};
