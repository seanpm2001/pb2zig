import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as N from './nodes.js';

export class PixelBenderToZigTranslator {
  lines;
  indent;
  ast;
  macroASTs;
  scopeStack;
  functionReceivers;
  functionArgTypes;
  variableTypes;
  parameterVariables;
  inputVariables;
  outputVariables;
  dependentVariables;
  evaluatingDependents;
  variableAliases;
  macros;

  translate(ast, macroASTs) {
    this.reset();
    this.ast = ast;
    this.macroASTs = macroASTs;
    this.addHeading();
    this.addImports();
    this.addKernel();
    this.addProcessFunctions();
    return this.lines.join('\n');
  }

  reset() {
    this.lines = [];
    this.indent = 0;
    this.scopeStack = [];
    this.variableTypes = {};
    this.functionReceivers = {};
    this.functionArgTypes = { ...builtInfunctionArgTypes };
    this.parameterVariables = {};
    this.inputVariables = {};
    this.outputVariables = {};
    this.dependentVariables = {};
    this.evaluatingDependents = false;
    this.variableAliases = [];
    this.macros = {};
    this.ast = null;
    this.macroASTs = null;
  }

  add(text) {
    const newLines = text.trim().split('\n').map(l => l.trim());
    for (const line of newLines) {
      let indent = this.indent;
      if (line.startsWith('}')) {
        indent--;
      }
      const spaces = ' '.repeat(Math.max(0, indent) * 4);
      this.lines.push(spaces + line);
      //console.log(spaces + line);
      for (const c of line) {
        if (c === '{') {
          this.indent++;
        } else if (c === '}') {
          this.indent--;
        }
      }
    }
  }

  walk(tree, cb, cbExit = null) {
    const f = (node) => {
      if (Array.isArray(node)) {
        for (const n of node) {
          const res = f(n);
          // end iteration if callback returns false
          if (res === false) {
            return false;
          }
        }
      } else if (node instanceof Object) {
        const res = cb(node);
        if (res !== undefined) {
          // call exit function if one is provided
          cbExit?.(node);
          return res;
        }
        // scan sub-nodes if callback doesn't return anything
        f(Object.values(node));
        cbExit?.(node);
      }
    };
    f(tree);
  }

  find(classes, recursive = false) {
    if (!Array.isArray(classes)) {
      classes = [ classes ];
    }
    const list = [];
    this.walk(this.ast, (node) => {
      if (classes.some(c => node instanceof c)) {
        list.push(node);
        if (!recursive) {
          return true;
        }
      }
    });
    return list;
  }

  startScope() {
    this.scopeStack.push(this.scope);
    this.variableTypes = { ...this.variableTypes };
  }

  endScope() {
    this.variableTypes = this.scopeStack.pop();
  }

  addTempVariable(lvalue, value) {
    let count = 1;
    let name;
    do {
      name = `tmp${count++}`;
    } while(this.hasVariable(name));
    this.variableTypes[name] = value.type;
    this.add(`const ${name} = ${value};`);
    this.variableAliases.push({ lvalue, name });
    return new ZigExpr(name, value.type);
  }

  hasFunction(name) {
    return !!this.functionArgTypes[name];
  }

  expandMacro(name, args = null) {
    const macro = this.macroASTs.find(m => m.name === name);
    if (!macro || !macro.args !== !args) {
      return null;
    }
    const argsByName = {};
    if (macro.args) {
      if (macro.args.length !== args.length) {
        const s = (macro.args.length > 1) ? 's' : '';
        throw new Error(`Macro ${name}() expects ${macro.args.length} argument${s}, received ${args?.length}`);
      }
      for (const [ index, argName ] of macro.args.entries()) {
        argsByName[argName] = args[index];
      }
    }
    const clone = (object) => {
      if (Array.isArray(object)) {
        return object.map(clone);
      } else if (object && typeof(object) === 'object') {
        if (object instanceof N.VariableAccess) {
          const { name, property } = object;
          const arg = argsByName[name];
          if (arg) {
            if (property) {
              // access the prop of the argument
              return this.createExpression(N.VariableAccess, { name: arg.name, property });
            } else {
              return arg;
            }
          }
        }
        const copy = new object.constructor();
        for (const [ name, child ] of Object.entries(object)) {
          copy[name] = clone(child);
        }
        return copy;
      } else {
        return object;
      }
    };
    const expanded = clone(macro.expression);
    return expanded;
  }

  expandAssignmentOp({ lvalue, operator, rvalue }) {
    const expression = this.createExpression(N.ArithmeticOperation, {
      operator: operator.charAt(0),
      operand1: lvalue,
      operand2: rvalue,
    });
    return this.createExpression(N.AssignmentOperation, {
      operator: '=',
      lvalue,
      rvalue: expression,
    });
  }

  getReturnValueType(name, args) {
    const argTypes = this.functionArgTypes[name];
    if (!argTypes) {
      throw new Error(`Undeclared function: ${name}()`);
    }
    const overloaded = Array.isArray(argTypes[0]);
    const types = args.map(a => a?.type);
    const findMismatch = (argTypes) => types.findIndex((type, i) => type !== argTypes[i + 1]);
    if (overloaded) {
      for (const argTypesN of argTypes) {
        const index = findMismatch(argTypesN);
        if (index === -1) {
          return argTypesN[0];
        }
      }
      throw new Error(`${name}(${types.join(', ')}) does not exists"`);
    } else {
      const index = args.findIndex((arg, i) => arg.type !== argTypes[i + 1]);
      if (index !== -1) {
        throw new Error(`${name}() expects argument ${index + 1} to be ${argTypes[index + 1]}, got ${types[index]}`);
      }
      return argTypes[0];
    }
  }

  addImports() {
    this.add(`const std = @import("std");`);
    this.add(``);
  }

  addHeading() {
    const { name, meta } = this.ast;
    this.add(`// Pixel Bender "${name}" (translated using pb2zig)`);
  }

  addKernel() {
    this.add(`pub const kernel = struct {`);
    this.addGlobalConstants();
    this.addMetadata();
    this.addParameterDecls();
    this.addInputImages();
    this.addOutputImages();
    this.add(``);
    this.addInstanceFunction();
    this.add(``);
    this.addCreateFunction();
    this.add(`};`);
  }

  addGlobalConstants() {
    // convert macros without dependencies on unknown variables into constants
    let count = 0;
    for (const macro of this.macroASTs) {
      const { name, args, expression } = macro;
      if (!args) {
        try {
          const expr = this.translateExpression(expression);
          if (count === 0) {
            this.add(`// constants`);
          }
          this.add(`const ${name} = ${expr};`);
          this.variableTypes[name] = expr.type;
          count++;
        } catch (err) {
          // if the expression uses variables not defined in the global
          // scope, it will fail and land here
        }
      }
    }
    if (count > 0) {
      this.add(``);
    }
  }

  addMetadata() {
    this.add(`// kernel information`);
    for (const [ field, literal ] of Object.entries(this.ast.meta)) {
      if (literal) {
        this.add(`pub const ${field} = ${this.translateExpression(literal)};`);
      }
    }
  }

  addParameterDecls() {
    const params = this.find(N.Parameter);
    this.add(`pub const parameters = .{`);
    for (const param of params) {
      const {
        name,
        type,
        minValue,
        maxValue,
        stepInterval,
        defaultValue,
        previewValue,
        ...others
      } = param;
      this.parameterVariables[name] = type;
      const typeZ = getZigType(type);
      this.add(`.${param.name} = .{`);
      this.add(`.type = ${typeZ},`);
      if (minValue !== undefined) {
        this.add(`.minValue = ${this.translateExpression(minValue, 'comptime')},`);
      }
      if (maxValue !== undefined) {
        this.add(`.maxValue = ${this.translateExpression(maxValue, 'comptime')},`);
      }
      if (stepInterval !== undefined) {
        this.add(`.stepInterval = ${this.translateExpression(stepInterval, 'comptime')},`);
      }
      if (defaultValue !== undefined) {
        this.add(`.defaultValue = ${this.translateExpression(defaultValue, 'comptime')},`);
      }
      if (previewValue !== undefined) {
        this.add(`.previewValue = ${this.translateExpression(previewValue, 'comptime')},`);
      }
      for (const [ name, value ] of Object.entries(others)) {
        if (value) {
          this.add(`.${name} = ${this.translateExpression(value)},`);
        }
      }
      this.add(`},`);
    }
    this.add(`};`);
  }

  addInputImages() {
    const inputs = this.find(N.InputDeclaration);
    this.add(`pub const input_images = .{`);
    for (const { name, type } of inputs) {
      const channels = getVectorWidth(type);
      this.add(`.${name} = .{ .channels = ${channels} },`);
      this.inputVariables[name] = type;
    }
    this.add('};');
  }

  addOutputImages() {
    const outputs = this.find(N.OutputDeclaration);
    this.add(`pub const output_images = .{`);
    for (const { name, type } of outputs) {
      const channels = getVectorWidth(type);
      this.add(`.${name} = .{ .channels = ${channels} },`);
      this.outputVariables[name] = type;
    }
    this.add('};');
  }

  addInstanceFunction() {
    this.add(`// generic kernel instance type`);
    this.add(`fn Instance(comptime InputStruct: type, comptime OutputStruct: type) type {`);
    this.add(`return struct {`);
    this.addInputOutput();
    this.addDependents();
    this.addConstants();
    this.addMacroFunctions();
    this.addDefinedFunctions();
    this.addCalledFunctions();
    this.add(`};`);
    this.add(`}`);
  }

  addInputOutput() {
    this.add(`input: InputStruct,`);
    this.add(`output: OutputStruct,`);
    this.add(`outputCoord: @Vector(2, u32) = @splat(0),`);
    this.add(``);
    this.add(`// output pixel`);
    for (const [ name, type ] of Object.entries(this.outputVariables)) {
      const typeZ = getZigType(type);
      this.add(`${name}: ${typeZ} = undefined,`);
    }
    this.add(``);
    this.add(`fn clearOutputPixel(self: *@This()) void {`)
    for (const [ name, type ] of Object.entries(this.outputVariables)) {
      this.add(`self.${name} = @splat(0);`);
    }
    this.add(`}`)
    this.add(``);
    this.add(`fn setOutputPixel(self: *@This()) void {`)
    this.add(`const x = self.outputCoord[0];`);
    this.add(`const y = self.outputCoord[1];`);
    for (const [ name, type ] of Object.entries(this.outputVariables)) {
      this.add(`self.output.${name}.setPixel(x, y, self.${name});`);
    }
    this.add(`}`)
    this.add(``);
    this.add(`fn outCoord(self: *@This()) @Vector(2, f32) {`);
    this.add(`const x = self.outputCoord[0];`);
    this.add(`const y = self.outputCoord[1];`);
    this.add(`return .{ @floatFromInt(x), @floatFromInt(y) };`);
    this.add(`}`);
    this.add(``);
  }

  addConstants() {
    // look for function definition so we don't scan into them
    const decls = this.find([ N.ConstantDeclaration, N.FunctionDefinition ]).filter(d => d instanceof N.ConstantDeclaration);
    if (decls.length > 0) {
      this.add(`// constants`);
      for (const decl of decls) {
        this.addStatement(decl);
      }
      this.add(``);
    }
  }

  addDependents() {
    const decls = this.find(N.DependentDeclaration);
    if (decls.length > 0) {
      this.add(`// dependent variables`);
      for (const { name, type } of decls) {
        this.add(`${name}: ${type},`);
      }
      this.add(``);
    }
  }

  addCreateFunction() {
    this.add(`// kernel instance creation function`);
    this.add(`
      pub fn create(input: anytype, output: anytype) Instance(@TypeOf(input), @TypeOf(output)) {
        return .{
          .input = input,
          .output = output,
        };
      }
    `.trim());
  }

  addProcessFunctions() {
    const codeURL = new URL('../zig/process.zig', import.meta.url);
    const content = readFileSync(fileURLToPath(codeURL), 'utf-8');
    const marker = '//---start of code';
    const index = content.indexOf(marker);
    const code = content.substring(index + marker.length);
    this.add(``);
    this.add(code);
  }

  addCalledFunctions() {
    // find function calls
    const inUse = {};
    const calls = this.find(N.FunctionCall, true);
    for (const { name, args } of calls) {
      switch (name) {
        case 'outCoord':
          // this get turned into a method call on the kernel
          break;
        case 'sample':
        case 'sampleNearest':
        case 'sampleLinear':
          // these get turned into method calls on the source image
          break;
        case 'atan':
          inUse[(args.length === 2) ? 'atan2' : 'atan'] = true;
          break;
        default:
          inUse[name] = true;
      }
    }

    // find matrix variables
    const variables = this.find([
      N.FunctionDefinition,
      N.FunctionArgument,
      N.VariableDeclaration,
      N.ConstantDeclaration,
      N.DependentDeclaration,
      N.Parameter,
    ], true);
    if (variables.some(v => isMatrix(v.type))) {
      inUse['MatrixCalcResult'] = true;
      inUse['matrixCalc'] = true;
    }

    const codeURL = new URL('../zig/functions.zig', import.meta.url);
    const code = readFileSync(fileURLToPath(codeURL), 'utf-8');
    const regExp = /pub (fn (\w+)[\s\S]*?\n})/g;
    let m, count = 0;
    while (m = regExp.exec(code)) {
      // excluding "pub"
      const func = m[1], name = m[2];
      if (inUse[name]) {
        this.add(``);
        if (count === 0) {
          this.add(`// built-in Pixel Bender functions`);
        }
        this.add(func);
        count++;
      }
    }
  }

  addDefinedFunctions() {
    const defs = this.find(N.FunctionDefinition);
    // set the function prototype first
    for (const { name, type, args } of defs) {
      const types = [ type ];
      for (const arg of args) {
        types.push(arg.type);
      }
      this.functionArgTypes[name] = types;
    }
    // add the actual code
    for (const [ index, def ] of defs.entries()) {
      const { type, args } = def;
      if (isUnsupported(type) || args.some(a => isUnsupported(a.type))) {
        continue;
      }
      if (index === 0) {
        this.add(`// functions defined in kernel`);
      } else {
        this.add(``);
      }
      this.addDefinedFunction(def);
    }
  }

  addMacroFunctions() {
    let count = 0;
    for (const macro of this.macroASTs) {
      const { name, args, expression } = macro;
      if (args) {
        // see if we can handle it as a generic function
        try {
          this.startScope();
          for (const name of args) {
            this.variableTypes[name] = 'anytype';
          }
          const expr = this.translateExpression(expression);
          const argList = args.map(name => `${name}: anytype`);
          let returnType;
          if (expr.type === 'anytype') {
            returnType = `@TypeOf(${args[0]})`;
          } else {
            returnType = getZigType(expr.type);
          }
          if (count === 0) {
            this.add(`// macro functions`);
          }
          this.add(`fn ${name}(${argList.join(', ')}) ${returnType} {`);
          this.add(`return ${expr};`);
          this.add(`}`)
          count++;
        } catch (err) {
          // must be expanded
        } finally {
          this.endScope();
        }
      }
    }
    if (count > 0) {
      this.add(``);
    }
  }

  findExternalReferences(statements) {
    const referenced = {};
    let scope = { ...this.scope };
    const scopeStack = [];
    this.walk(statements, (node) => {
      if (node instanceof N.VariableAccess) {
        if (!scope[node.name]) {
          referenced[node.name] = true;
        }
      } else if (node.statements) {
        scopeStack.push(scope);
        scope = { ...scope };
      } else if (node instanceof N.VariableDeclaration) {
        scope[node.name] = node.type;
      }
    }, (node) => {
      if (node.statements) {
        scope = scopeStack.pop();
      }
    });
    return Object.keys(referenced);
  }

  addExternalReferences(names) {
    let count = 0;
    for (const name of names) {
      // variables outside a function's scope are either parameters,
      // global constants, or dependent variables
      let type;
      if (type = this.parameterVariables[name]) {
        this.add(`const ${name} = self.input.${name};`);
        this.variableTypes[name] = type;
        count++;
      } else if (type = this.dependentVariables[name]) {
        if (!this.evaluatingDependents) {
          // place value in a const or it cannot be unintentionally changed
          this.add(`const ${name} = self.${name};`);
          this.variableTypes[name] = type;
          count++;
        } else {
          // translateVariableAccess() should return self.[name] so the
          // variable can be modified
        }
      } else {
        // the variable is either a reference to an input/output image or undefined
        // in any event, we don't need to deal with it here
      }
    }
    if (count > 0) {
      this.add(``);
    }
  }

  addDefinedFunction(def) {
    const { name, type, args, statements } = def;
    this.startScope(name);
    for (const arg of args) {
      this.variableTypes[arg.name] = arg.type;
    }
    const argList = args.map(a => `${a.name}: ${getZigType(a.type)}`);
    const external = this.findExternalReferences(statements);
    if (external.length > 0) {
      // need self variable if the function access external variables
      argList.push(`self: *@This()`);
      this.functionReceivers[name] = 'self';
    }
    let prefix = '';
    switch (name) {
      case 'evaluateDependents':
      case 'evaluatePixel':
        prefix = 'pub ';
        break;
    }
    this.add(`${prefix}fn ${name}(${argList.join(', ')}) ${getZigType(type)} {`);
    if (name === 'evaluatePixel') {
      this.add(`self.clearOutputPixel();`);
    }
    this.addExternalReferences(external);
    this.addStatements(statements);
    if (name === 'evaluatePixel') {
      this.add(``);
      this.add(`self.setOutputPixel();`);
    }
    this.endScope();
    this.add('}');
  }

  addStatements(statements) {
    for (const statement of statements) {
      this.addStatement(statement);
    }
  }

  addStatement(statement) {
    const fname = `add${statement.constructor.name}`;
    const f = this[fname];
    if (f) {
      f.call(this, statement);
    } else {
      this.add(`[TODO: ${fname}];`);
      console.log(statement);
    }
    this.variableAliases = [];
  }

  addVariableDeclaration({ type, name, initializer }) {
    const valueR = (initializer) ? this.translateExpression(initializer, type) : 'undefined';
    this.add(`var ${name}: ${getZigType(type)} = ${valueR};`);
    this.variableTypes[name] = type;
  }

  addConstantDeclaration({ type, name, initializer }) {
    const valueR = this.translateExpression(initializer, type);
    this.add(`const ${name}: ${getZigType(type)} = ${valueR};`);
    this.variableTypes[name] = type;
  }

  addExpressionStatement({ expression }) {
    const op = this.translateExpression(expression, 'void');
    if (op !== null) {
      this.add(`${op};`);
    }
  }

  addIfStatement(stmt) {
    let elsePrefix = '';
    do {
      const { condition, statements, elseClause } = stmt;
      const line = (condition) ? `if (${this.translateExpression(condition)}) {` : `{`;
      this.add(elsePrefix + line);
      this.startScope();
      this.addStatements(statements);
      this.endScope();
      if (elseClause) {
        stmt = elseClause;
        elsePrefix = `} else `;
      } else {
        elsePrefix = ``;
      }
    } while (elsePrefix);
    this.add(`}`);
  }

  addReturnStatement({ expression }) {
    const expr = this.translateExpression(expression);
    this.add(`return ${expr};`);
  }

  createExpression(c, props) {
    const obj = new c;
    for (const [ name, value ] of Object.entries(props)) {
      obj[name] = value;
    }
    return obj;
  }

  translateExpression(expression, typeExpected) {
    const fname = `translate${expression.constructor.name}`;
    const f = this[fname];
    if (f) {
      return f.call(this, expression, typeExpected);
    } else {
      if (expression.constructor.name === 'ZigExpr') {
        throw new Error('Already translated');
      }
      console.log(expression);
      return new ZigExpr(`[TODO: ${fname}]`, 'bool');
    }
  }

  translateLiteral({ type, value }, typeExpected) {
    if (type == 'int' && typeExpected?.startsWith('float')) {
      type = getChildType(typeExpected);
    }
    return new ZigExpr(getZigLiteral(value, type), type);
  }

  resolveVariable(name) {
    let value, type;
    if (type = this.variableTypes[name]) {
      value = new ZigExpr(name, type);
    } else {
      if (type = this.inputVariables[name]) {
        value = new ZigExpr(`self.input.${name}`, type);
      } else if (type = this.outputVariables[name]) {
        value = new ZigExpr(`self.${name}`, type);
      } else if (type = this.dependentVariables[name]) {
        value = new ZigExpr(`self.${name}`, type);
      } else {
        // expand the macro, since it wasn't possible to convert it to a variable
        const macro = this.expandMacro(name);
        if (macro) {
          value = this.translateExpression(macro);
        } else {
          throw new Error(`Undefined variable: ${name}`);
        }
      }
    }
    return value;
  }

  translateVariableAccess({ name, property, element }) {
    let value = this.resolveVariable(name);
    if (property) {
      const indices = getSwizzleIndices(property);
      const typeS = getSwizzleType(value.type, indices);
      if (indices.length > 1) {
        const typeCZ = getChildZigType(typeS);
        const mask = `@Vector(${indices.length}, i32){ ${indices.join(', ') } }`;
        value = new ZigExpr(`@shuffle(${typeCZ}, ${value}, undefined, ${mask})`, typeS);
      } else {
        const [ index ] = indices;
        value = new ZigExpr(`${value}[${index}]`, typeS);
      }
    } else if (element) {
      const index = this.translateExpression(element);
      const typeC = getChildType(value.type);
      value = new ZigExpr(`${value}[${index}]`, typeC);
    }
    return value;
  }

  translateElementAccess({ expression, property, element }) {
    const value = this.translateExpression(expression);
    const { type } = value;
    if (property) {
      const indices = getSwizzleIndices(property);
      const typeS = getSwizzleType(type, indices);
      if (indices.length > 1) {
        const typeCZ = getChildZigType(typeS);
        const mask = `@Vector(${indices.length}, i32){ ${indices.join(', ') } }`;
        return new ZigExpr(`@shuffle(${typeCZ}, ${value}, undefined, ${mask})`, typeS);
      } else {
        const [ index ] = indices;
        return new ZigExpr(`${value}[${index}]`, typeS);
      }
    } else {
      const index = this.translateExpression(element);
      const typeC = getChildType(type);
      return new ZigExpr(`${value}[${index}]`, typeC);
    }
  }

  translateIncrementOperation({ operator, lvalue, post }, typeExpected) {
    let tmp;
    if (typeExpected !== 'void' && post) {
      // save copy of variable when it's postfix
      const prevValue = this.translateExpression(lvalue, typeExpected);
      tmp = this.addTempVariable(lvalue, prevValue);
    }
    const assignment = this.createExpression(N.AssignmentOperation, {
      lvalue,
      operator: operator.charAt(0) + '=',
      rvalue: this.createExpression(N.Literal, { value: 1, type: 'int' })
    });
    const value = this.translateExpression(assignment, typeExpected);
    if (typeExpected === 'void') {
      return null;
    }
    return temp ?? value;
  }

  translateFunctionCall({ name, args }) {
    if (!this.hasFunction(name)) {
      const expanded = this.expandMacro(name, args);
      if (expanded) {
        return this.translateExpression(expanded);
      }
    }
    if (name === 'outCoord') {
      return new ZigExpr(`self.outCoord()`, 'float2');
    } else if (name === 'sample') {
      name = 'sampleLinear';
    } else if (name === 'atan') {
      if (args.length === 2) {
        name = 'atan2';
      }
    }
    let recv = this.functionReceivers[name];
    let argList = args.map(a => this.translateExpression(a));
    const type = this.getReturnValueType(name, argList);
    switch (name) {
      case 'sampleNearest':
      case 'sampleLinear':
      case 'pixelSize':
      case 'pixelAspectRatio':
        // functions called on images are translated as method calls
        recv = argList[0];
        argList = argList.slice(1);
        break;
    }
    if (recv) {
      name = `${recv}.${name}`;
    }
    return new ZigExpr(`${name}(${argList.join(', ')})`, type);
  }

  translateConstructorCall({ type, args }, typeExpected) {
    const argList = args.map(a => this.translateExpression(a, type));
    if (isMatrix(type)) {
      const typeV = getChildType(type);
      const width = getVectorWidth(typeV);
      const initializers = [];
      if (isVector(argList[0]?.type))  {
        initializers.push(...argList);
      } else if (argList.length === 1) {
        const arg = argList[0];
        arg.promote(typeV);
        for (let i = 0; i < width; i++) {
          initializers.push(arg);
        }
      } else {
        for (let i = 0, j = 0; i < width; i++, j += width) {
          const slice = argList.slice(j, j + width);
          initializers.push(`.{ ${slice.join(', ')} }`);
        }
      }
      const typeZ = getZigType(type);
      return new ZigExpr(`${typeZ}{\n${initializers.join(',\n')}\n}`, type);
    } else if (isVector(type)) {
      const typeC = getChildType(type);
      const width = getVectorWidth(type);
      argList.forEach(a => a.convert(typeC));
      if (typeExpected === 'comptime') {
        if (argList.length === 1) {
          while (argList.length < width) {
            argList.push(argList[0]);
          }
        }
        return new ZigExpr(`.{ ${argList.join(', ')} }`, type);
      } else {
        if (argList.length === 1) {
          const arg = argList[0];
          arg.promote(type);
          return arg;
        } else {
          const typeZ = getZigType(type);
          return new ZigExpr(`${typeZ}{ ${argList.join(', ')} }`, type);
        }
      }
    } else {
      const arg = argList[0];
      arg.convert(type);
      return arg;
    }
  }

  translateArithmeticOperation({ operator, operand1, operand2 }) {
    const opL = this.translateExpression(operand1);
    const opR = this.translateExpression(operand2);
    if (isMatrix(opL.type) || isMatrix(opR.type)) {
      // matrix math requires function calls
      let returnType;
      switch (operator) {
        case '+':
        case '-':
        case '/':
          returnType = opL.isMatrix() ? opL.type : opR.type;
          break;
        case '*':
          if (opL.isVector()) {
            returnType = opL.type;
          } else if (opR.isVector()) {
            returnType = opR.type;
          } else {
            returnType = opL.isMatrix() ? opL.type : opR.type;
          }
          break;
      }
      return new ZigExpr(`matrixCalc("${operator}", ${opL}, ${opR})`, returnType);
    }
    // promote scalar to vector
    if (opL.isScalar() && opR.isVector()) {
      opL.promote(opR.type);
    } else if (opL.isVector() && opR.isScalar()) {
      opR.promote(opL.type);
    }
    return new ZigExpr(`${opL} ${operator} ${opR}`, opL.type);
  }

  translateComparisonOperation({ operator, operand1, operand2 }) {
    switch (operator) {
      case '&&':
        operator = 'and';
        break;
      case '||':
        operator = 'or';
        break;
      case '^^':
        operator = '!=';
        break;
    };
    const opL = this.translateExpression(operand1);
    const opR = this.translateExpression(operand2);
    if (isMatrix(opL.type)) {
      // matrix comparison requires function calls
      return new ZigExpr(`matrixCalc("${operator}", ${opL}, ${opR})`, 'bool');
    } else if (isVector(opL.type)) {
      return new ZigExpr(`@reduce(.And, ${opL} ${operator} ${opR})`, 'bool');
    } else {
      return new ZigExpr(`${opL} ${operator} ${opR}`, 'bool');
    }
  }

  translateAssignmentOperation({ lvalue, operator, rvalue }, typeExpected) {
    const { name: nameL, property: propL, element: elemL } = lvalue;
    const variableL = this.resolveVariable(nameL);
    if (variableL.isMatrix() && operator.length === 2) {
      const assignment = this.expandAssignmentOp({ lvalue, operator, rvalue });
      return this.translateBinaryOperation(assignment, typeExpected);
    }
    let value;
    if (propL) {
      // using vector write mask
      const indicesL = getSwizzleIndices(propL);
      if (indicesL.length > 1) {
        if (operator.length === 2) {
          // += and friends--handle it a lvalue = lvalue + rvalue
          const assignment = this.expandAssignmentOp({ lvalue, operator, rvalue });
          return this.translateAssignmentOperation(assignment, typeExpected);
        }
        const typeS = getSwizzleType(variableL.type, indicesL);
        let valueR, indicesR;
        if (rvalue instanceof N.VariableAccess && rvalue.property) {
          // the right size has a mask too, get its indices
          const { name: nameR, property: propR } = rvalue;
          const variableR = this.resolveVariable(nameR);
          valueR = new ZigExpr(nameR, variableR.type);
          indicesR = getSwizzleIndices(propR);
        } else {
          // get the full vector and a list of sequential indices
          valueR = this.translateExpression(rvalue, typeS) ;
          indicesR = getVectorIndices(typeS);
        }
        // build the shuffle mask
        const indicesM = [];
        const widthL = getVectorWidth(variableL.type);
        for (let i = 0; i < widthL; i++) {
          if (indicesL.includes(i)) {
            // use rvalue--index is negative
            indicesM.push(~indicesR[i]);
          } else {
            // keep lvalue
            indicesM.push(`${i}`);
          }
        }
        const mask1 = `@Vector(${indicesM.length}, i32){ ${indicesM.join(', ') } }`;
        const typeCZ = getChildZigType(variableL.type);
        // make the change (to the whole vector)
        this.add(`${variableL} = @shuffle(${typeCZ}, ${variableL}, ${valueR}, ${mask1});`);
        // get the value afterward (only part of the vector)
        const mask2 = `@Vector(${indicesL.length}, i32){ ${indicesL.join(', ') } }`;
        value = new ZigExpr(`@shuffle(${typeCZ}, ${variableL}, undefined, ${mask2})`, typeS);
      } else {
        const [ index ] = indicesL;
        const valueR = this.translateExpression(rvalue, variableL.type);
        const typeC = getChildType(variableL.type);
        this.add(`${variableL}[${index}] ${operator} ${valueR};`);
        value = new ZigExpr(`${variableL}[${index}]`, typeC);
      }
    } else if (elemL) {
      const index = this.translateExpression(elemL);
      const typeLC = getChildType(variableL.type);
      const valueR = this.translateExpression(rvalue, typeLC);
      valueR.promote(typeLC);
      this.add(`${variableL}[${index}] ${operator} ${valueR};`);
      value = new ZigExpr(`${variableL}[${index}]`, typeLC);
    } else {
      const valueR = this.translateExpression(rvalue, variableL.type);
      valueR.promote(variableL.type);
      this.add(`${variableL} ${operator} ${valueR};`);
      value = variableL;
    }
    if (typeExpected === 'void') {
      return null;
    }
    // need to save the value to a temporary variable, since the lvalue
    // can get modified again
    return this.addTempVariable(lvalue, value);
  }

  translateSignOperation({ sign, operand }) {
    const op = this.translateExpression(operand);
    return (sign === '+') ? op : new ZigExpr(`-${op}`, op.type);
  }

  translateNotOperation({ operand }) {
    const op = this.translateExpression(operand);
    return new ZigExpr(`!${op}`, 'bool');
  }

  translateParentheses({ expression }) {
    const expr = this.translateExpression(expression);
    if (/^\w+$/.test(expr) || /^@as\(.*\)$/.test(expr)) {
      // don't need the parentheses
      return expr;
    }
    return new ZigExpr(`(${expr})`, expr.type);
  }

  translateConditional({ condition, onTrue, onFalse }) {
    const c = this.translateExpression(condition);
    const t = this.translateExpression(onTrue);
    const f = this.translateExpression(onFalse);
    const typeZ = getZigType(t.type);
    return new ZigExpr(`@as(${typeZ}, if (${c}) ${t} else ${f})`, t.type);
  }
}

const translater = new PixelBenderToZigTranslator();

export function translate(ast, macroASTs) {
  return translater.translate(ast, macroASTs);
}

class ZigExpr {
  constructor(text, type) {
    this.text = text;
    this.type = type;
  }

  isVector() {
    return isVector(this.type);
  }

  isMatrix() {
    return isMatrix(this.type);
  }

  isScalar() {
    return !this.isMatrix() && !this.isVector();
  }

  promote(type) {
    if (this.type !== type && !this.isVector()) {
      if (!isVector(type)) {
        throw new Error('Can only promote from scalar to vector');
      }
      if (this.isMatrix()) {
        throw new Error('Cannot promote from matrix to vector');
      }
      this.convert(getChildType(type));
      const typeZ = getZigType(type);
      this.text = `@as(${typeZ}, @splat(${this.text}))`;
      this.type = type;
    }
  }

  convert(type) {
    if (this.type !== type) {
      if (type === 'bool') {
        this.text = `(${this.text} == 0)`;
      } else if (this.type === 'bool') {
        this.text = `(if (${this.text}) 1 else 0)`;
      } else if (type === 'float') {
        const value = parseFloat(this.text);
        if (isNaN(value)) {
          const typeZ = getZigType(type);
          this.text = `@as(${typeZ}, @floatFromInt(${this.text}))`;
        } else {
          this.text = getZigLiteral(value, type);
        }
      } else if (type === 'int') {
        const value = parseInt(this.text);
        if (isNaN(value)) {
          const typeZ = getZigType(type);
          this.text = `@as(${typeZ}, @intFromFloat(${this.text}))`;
        } else {
          this.text = getZigLiteral(value, type);
        }
      }
    }
    this.type = type;
  }

  toString() {
    return this.text;
  }
}

function getType(baseType, width) {
  return (width > 1) ? baseType + width : baseType;
}

function getZigType(type) {
  if (type === undefined) {
    return undefined;
  }
  if (type.startsWith('image')) {
    return 'Image';
  }
  const table = {
    bool: 'bool',
    bool2: 'bool[2]',
    bool3: 'bool[3]',
    bool4: 'bool[4]',

    int: 'i32',
    int2: '@Vector(2, i32)',
    int3: '@Vector(3, i32)',
    int4: '@Vector(4, i32)',

    float: 'f32',
    float2: '@Vector(2, f32)',
    float3: '@Vector(3, f32)',
    float4: '@Vector(4, f32)',

    float2x2: '[2]@Vector(2, f32)',
    float3x3: '[3]@Vector(3, f32)',
    float4x4: '[4]@Vector(4, f32)',

    void: 'void',
  };
  const zigType = table[type];
  if (!zigType) {
    throw new Error(`Unknown type: ${type}`);
  }
  return zigType;
}

function getChildZigType(type) {
  return getZigType(getChildType(type));
}

function getChildType(type) {
  if (isMatrix(type)) {
    return type.slice(0, -2);
  } else if (isVector(type)) {
    return type.slice(0, -1);
  } else {
    return type;
  }
}

function isVector(type) {
  return /^[_a-z]+\d$/i.test(type);
}

function isMatrix(type) {
  return /^[_a-z]+\dx\d$/i.test(type);
}

function isUnsupported(type) {
  return [ 'region', 'imageRef' ].includes(type);
}

function getVectorWidth(type) {
  if (type === undefined) {
    return undefined;
  }
  return parseInt(type.slice(-1), '') || 1;
}

function getVectorIndices(type) {
  const width = getVectorWidth(type);
  const indices = [];
  for (let i = 0; i < width; i++) {
    indices.push(i);
  }
  return indices;
}

function getSwizzleIndices(prop) {
  if (prop) {
    const map = {
      r: 0, g: 1, b: 2, a: 3,
      x: 0, y: 1, z: 2, w: 3,
      s: 0, t: 1, p: 2, q: 3,
    };
    return [ ...prop ].map(c => map[c]);
  }
}

function getSwizzleType(type, indices) {
  const typeE = type.slice(0, -1);
  return (indices.length === 1) ? typeE : typeE + indices.length;
}

function getZigLiteral(value, type) {
  if (type === 'float') {
    let s = value.toString();
    if (s.indexOf('.') === -1) {
      s = value.toFixed(1);
    }
    return s;
  } else {
    return JSON.stringify(value);
  }
}

const bool = 'bool';
const bool2 = 'bool2';
const bool3 = 'bool3';
const bool4 = 'bool4';
const int = 'int';
const int2 = 'int2';
const int3 = 'int3';
const int4 = 'int4';
const float = 'float';
const float2 = 'float2';
const float3 = 'float3';
const float4 = 'float4';
const float2x2 = 'float2x2';
const float3x3 = 'float3x3';
const float4x4 = 'float4x4';
const image1 = 'image1';
const image2 = 'image2';
const image3 = 'image3';
const image4 = 'image4';

const fx__fx = [
  [ float, float ],
  [ float2, float2 ],
  [ float3, float3 ],
  [ float4, float4 ],
];
const fx__fx_fx = [
  [ float, float, float ],
  [ float2, float2, float2 ],
  [ float3, float3, float3 ],
  [ float4, float4, float4 ],
];
const fx__fx_fx1 = [
  ...fx__fx_fx,
  [ float2, float2, float ],
  [ float3, float3, float ],
  [ float4, float4, float ],
];
const fx__fx1_fx = [
  ...fx__fx_fx,
  [ float2, float, float2 ],
  [ float3, float, float3 ],
  [ float4, float, float4 ],
];
const fx__fx_fx_fx = [
  [ float, float, float, float ],
  [ float2, float2, float2, float2 ],
  [ float3, float3, float3, float3 ],
  [ float4, float4, float4, float4 ],
];
const f__fx_fx = [
  [ float, float, float ],
  [ float, float2, float2 ],
  [ float, float3, float3 ],
  [ float, float4, float4 ],
];
const bv__ifv_ifv = [
  [ bool2, int2, int2 ],
  [ bool3, int3, int3 ],
  [ bool4, int4, int4 ],
  [ bool2, float2, float2 ],
  [ bool3, float3, float3 ],
  [ bool4, float4, float4 ],
];
const bv__bifv_bifv = [
  [ bool2, bool2, bool2 ],
  [ bool3, bool3, bool3 ],
  [ bool4, bool4, bool4 ],
  ...bv__ifv_ifv,
];
const b__bv = [
  [ bool, bool2 ],
  [ bool, bool3 ],
  [ bool, bool4 ],
];
const px__im_f2 = [
  [ float, image1, float2 ],
  [ float2, image2, float2 ],
  [ float3, image3, float2 ],
  [ float4, image4, float2 ],
];

const builtInfunctionArgTypes = {
  outCoord: [ float2 ],
  radians: fx__fx,
  degrees: fx__fx,
  sin: fx__fx,
  cos: fx__fx,
  tan: fx__fx,
  asin: fx__fx,
  acos: fx__fx,
  atan: fx__fx,
  atan2: fx__fx_fx,
  pow: fx__fx_fx,
  exp: fx__fx,
  exp2: fx__fx,
  log: fx__fx,
  log2: fx__fx,
  sqrt: fx__fx,
  inverseSqrt: fx__fx,
  abs: fx__fx,
  sign: fx__fx,
  floor: fx__fx,
  ceil: fx__fx,
  fract: fx__fx,
  mod: fx__fx_fx1,
  min: fx__fx_fx1,
  max: fx__fx_fx1,
  mod: fx__fx_fx1,
  step: fx__fx1_fx,
  clamp: [
    ...fx__fx_fx_fx,
    [ float2, float2, float, float ],
    [ float3, float3, float, float ],
    [ float4, float4, float, float ],
  ],
  mix: [
    ...fx__fx_fx_fx,
    [ float2, float2, float2, float ],
    [ float3, float3, float3, float ],
    [ float4, float4, float4, float ],
  ],
  smoothStep: [
    ...fx__fx_fx_fx,
    [ float2, float, float, float2 ],
    [ float3, float, float, float3 ],
    [ float4, float, float, float4 ],
  ],
  length: [
    [ float, float ],
    [ float, float2 ],
    [ float, float3 ],
    [ float, float4 ],
  ],
  distance: f__fx_fx,
  dot: f__fx_fx,
  cross: fx__fx_fx,
  normalize: fx__fx,
  matrixCompMult: [
    [ float2x2, float2x2, float2x2 ],
    [ float3x3, float3x3, float3x3 ],
    [ float4x4, float4x4, float4x4 ],
  ],
  lessThan: bv__ifv_ifv,
  lessThanEqual: bv__ifv_ifv,
  greaterThan: bv__ifv_ifv,
  greaterThanEqual: bv__ifv_ifv,
  equal: bv__bifv_bifv,
  notEqual: bv__bifv_bifv,
  any: b__bv,
  all: b__bv,
  not: [
    [ bool2, bool2 ],
    [ bool3, bool3 ],
    [ bool4, bool4 ],
  ],
  sampleLinear: px__im_f2,
  sampleNearest: px__im_f2,
  pixelSize: [
    [ float2, image1 ],
    [ float2, image2 ],
    [ float2, image3 ],
    [ float2, image4 ],
    [ float2, float ],
    [ float2, float2 ],
    [ float2, float3 ],
    [ float2, float4 ],
  ],
  pixelAspectRatio: [
    [ float, image1 ],
    [ float, image2 ],
    [ float, image3 ],
    [ float, image4 ],
    [ float, float ],
    [ float, float2 ],
    [ float, float3 ],
    [ float, float4 ],
  ],
};

