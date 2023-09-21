import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as N from './nodes.js';

export class PixelBenderToZigTranslator {
  lines;
  indent;
  scopeStack;
  scope;
  functionArgTypes;
  ast;
  macroASTs;
  variableAliases;

  translate(ast, macroASTs) {
    this.reset();
    this.ast = ast;
    this.macroASTs = macroASTs;
    this.addMetadata();
    this.addImports();
    this.addKernel();
    this.addProcessFunctions();
    return this.lines.join('\n');
  }

  reset() {
    this.lines = [ '' ];
    this.indent = 0;
    this.scopeStack = [];
    this.scope = {};
    this.functionArgTypes = { ...builtInfunctionArgTypes };
    this.variableAliases = {};
    this.macros = {};
    this.ast = null;
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
      for (const c of line) {
        if (c === '{') {
          this.indent++;
        } else if (c === '}') {
          this.indent--;
        }
      }
    }
  }

  walk(tree, cb) {
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
          return res;
        }
        // scan sub-nodes if callback doesn't return anything
        f(Object.values(node));
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
    this.scope = { ...this.scope };
  }

  endScope() {
    this.scope = this.scopeStack.pop();
  }

  setVariableType(name, type) {
    this.scope[name] = type;
  }

  getVariableType(name) {
    const type = this.scope[name];
    if (!type) {
      throw new Error(`Undefined variable: ${name}`);
    }
    return type;
  }

  hasVariable(name) {
    return !!this.scope[name];
  }

  getVariableAlias(name) {
    return this.variableAliases[name] ?? name;
  }

  clearVariableAliases() {
    this.variableAliases = {};
  }

  addTempVariable(target) {
    let count = 1;
    let name;
    do {
      name = `tmp${count++}`;
    } while(this.hasVariable(name));
    this.setVariableType(name, 'anytype');
    this.add(`const ${name} = ${target};`);
    this.variableAliases[target] = name;
    return name;
  }

  hasFunction(name) {
    return !!this.functionArgTypes[name];
  }

  expandMacro(name, args) {
    const macro = this.macroASTs.find(m => m.name === name);
    if (!macro) {
      return null;
    }
    if (macro.args.length !== args.length) {
      const s = (macro.args.length > 1) ? 's' : '';
      throw new Error(`Macro ${name}() expects ${macro.args.length} argument${s}, received ${args.length}`);
    }
    const argsByName = {};
    for (const [ index, argName ] of macro.args.entries()) {
      argsByName[argName] = args[index];
    }
    const clone = function(object) {
      if (Array.isArray(object)) {
        return object.map(clone);
      } else if (object && typeof(object) === 'object') {
        if (object instanceof N.VariableAccess) {
          const [ name, prop ] = object.names;
          const arg = argsByName[name];
          if (arg) {
            if (prop) {
              const argProp = new N.VariableAccess();
              argProp.names = [ arg.names[0], prop ];
              return argProp;
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

  setFunctionArgs(name, argTypes) {
    this.functionArgTypes[name] = argTypes;
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

  addMetadata() {
    const { name, meta } = this.ast;
    this.add(`// Pixel Bender "${name}" (translated using pb2zig)`);
    for (const [ field, literal ] of Object.entries(meta)) {
      if (literal?.value) {
        this.add(`// ${field}: ${literal.value}`);
      }
    }
    this.add(``);
  }

  addKernel() {
    this.add(`pub const kernel = struct {`);
    this.addParameterDecls();
    this.addInput();
    this.addOutput();
    this.add(``);
    this.addInstanceFunction();
    this.add(``);
    this.addCreateFunction();
    this.add(`};`);
  }

  addParameterDecls() {
    const params = this.find(N.Parameter);
    this.add(`// kernel information`);
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
      this.add(`.${param.name} = .{`);
      this.add(`.type = ${getZigType(type)},`);
      if (minValue !== undefined) {
        this.add(`.min_value = ${this.translateExpression(minValue, type)},`);
      }
      if (maxValue !== undefined) {
        this.add(`.max_value = ${this.translateExpression(maxValue, type)},`);
      }
      if (stepInterval !== undefined) {
        this.add(`.step_interval = ${this.translateExpression(stepInterval, type)},`);
      }
      if (defaultValue !== undefined) {
        this.add(`.default_value = ${this.translateExpression(defaultValue, type)},`);
      }
      if (previewValue !== undefined) {
        this.add(`.preview_value = ${this.translateExpression(previewValue, type)},`);
      }
      for (const [ name, value ] of Object.entries(others)) {
        if (value) {
          this.add(`.${snakeCase(name)} = ${this.translateExpression(value)},`);
        }
      }
      this.add(`},`);
    }
    this.add(`};`);
  }

  addInput() {
    const inputs = this.find(N.InputDeclaration);
    this.add(`pub const input = .{`);
    for (const { name, type } of inputs) {
      const channels = getVectorWidth(type);
      this.add(`.${name} = .{ .channels = ${channels} },`);
    }
    this.add('};');
  }

  addOutput() {
    const outputs = this.find(N.OutputDeclaration);
    this.add(`pub const output = .{`);
    for (const { name, type } of outputs) {
      const channels = getVectorWidth(type);
      this.add(`.${name} = .{ .channels = ${channels} },`);
    }
    this.add('};');
  }

  addInstanceFunction() {
    this.add(`// generic kernel instance type`);
    this.add(`fn Instance(comptime InputStruct: type) type {`);
    this.add(`return struct {`);
    this.addParameterFields();
    this.addInputFields();
    this.addConstants();
    this.addCalledFunctions();
    this.addMacroFunctions();
    this.addDefinedFunctions();
    this.add(`};`);
    this.add(`}`);
  }

  addCreateFunction() {
    this.add(`// kernel instance creation function`);
    this.add(`
      pub fn create(inputStruct: anytype) Instance(@TypeOf(inputStruct)) {
        var instance: Instance(@TypeOf(inputStruct)) = undefined;
        inline for (std.meta.fields(@TypeOf(inputStruct))) |field| {
            @field(instance, field.name) = @field(inputStruct, field.name);
        }
        return instance;
      }
    `.trim());
  }

  addParameterFields() {
    const params = this.find(N.Parameter);
    if (params.length > 0) {
      this.add(`// parameter and input image fields`);
      for (const param of params) {
        const type = getZigType(param.type);
        this.add(`${param.name}: ${type},`);
      }
    }
  }

  addInputFields() {
    const inputs = this.find(N.InputDeclaration);
    if (inputs.length > 0) {
      for (const { name } of inputs) {
        this.add(`${name}: std.meta.fieldInfo(InputStruct, .src).type,`);
       }
    }
    this.add(``);
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
          // this become an input variable
          break;
        case 'sample':
        case 'sampleNearest':
        case 'sampleLinear':
          // these get turned into method calls on the src
          break;
        case 'atan':
          inUse[(args.length === 2) ? 'atan2' : 'atan'] = true;
          break;
        default:
          inUse[name] = true;
      }
    }

    // find matrix variables
    const variables = this.find([ N.FunctionDefinition, N.FunctionArgument, N.VariableDeclaration ], true);
    if (variables.some(v => /[234]x[234]$/.test(v.type))) {
      inUse['matrixMult'] = true;
    }

    const codeURL = new URL('../zig/functions.zig', import.meta.url);
    const code = readFileSync(fileURLToPath(codeURL), 'utf-8');
    const regExp = /pub (fn (\w+)[\s\S]*?\n})/g;
    let m, count = 0;
    while (m = regExp.exec(code)) {
      // excluding "pub"
      const func = m[1], name = m[2];
      if (inUse[name]) {
        if (count === 0) {
          this.add(`// built-in Pixel Bender functions`);
        }
        this.add(func);
        this.add(``);
        count++;
      }
    }
  }

  addDefinedFunctions() {
    const defs = this.find(N.FunctionDefinition);
    for (const [ index, def ] of defs.entries()) {
      if (index === 0) {
        this.add(`// functions defined in kernel`);
      } else {
        this.add(``);
      }
      this.addDefinedFunction(def);
    }
  }

  addConstants() {
    // look for function definition so we don't scan into them
    const decls = this.find([ N.ConstantDeclaration, N.FunctionDefinition ]).filter(d => d instanceof N.ConstantDeclaration);
    if (decls.length > 0) {
      this.add(`// constants`);
      for (const decl of decls) {
        this.addStatement(decl);
      }
    }
    // convert macros without dependencies on unknown variables into constants
    let count = decls.length;
    for (const macro of this.macroASTs) {
      const { name, args, expression } = macro;
      if (!args) {
        try {
          const expr = this.translateExpression(expression);
          if (count === 0) {
            this.add(`// constants`);
          }
          this.add(`const ${name} = ${expr};`);
          this.setVariableType(name, expr.type);
          count++;
        } catch (err) {
          // if the expression uses varaibles not defined in the global
          // scope, it will fail and land here
        }
      }
    }
    if (count > 0) {
      this.add(``);
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
            this.setVariableType(name, 'anytype');
          }
          const expr = this.translateExpression(expression);
          const argList = args.map(name => `${name}: anytype`);
          let returnType = expr.type;
          if (returnType === 'anytype') {
            returnType = `@TypeOf(${args[0]})`;
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

  addDependentVariables() {
    const decls = this.find(N.DependentDeclaration);
    for (const [ index, decl ] of decls.entries()) {
      if (index === 0) {
        this.add(`// dependent variables`);
      }
      this.addStatement(decl);
    }
  }

  addDefinedFunction(def) {
    const { name, type, args, statements } = def;
    this.startScope();
    if (name === 'evaluatePixel') {
      this.add(`pub fn ${name}(self: @This(), outCoord: @Vector(2, f32)) @Vector(4, f32) {`)
      this.add(`// input variables`);
      const parameters = this.find(N.Parameter);
      for (const { name, type } of parameters) {
        this.add(`const ${name} = self.${name};`);
        this.setVariableType(name, type);
      }
      const inputs = this.find(N.InputDeclaration);
      for (const { name, type } of inputs) {
        this.add(`const ${name} = self.${name};`);
        this.setVariableType(name, type);
      }
      this.add(``);
      const outputs = this.find(N.OutputDeclaration);
      this.add(`// output variable`);
      for (const { name, type } of outputs) {
        this.add(`var ${name}: ${getZigType(type)} = undefined;`);
        this.setVariableType(name, type);
      }
      this.add(``);
      this.addStatements(statements);
      for (const { name } of outputs) {
        this.add(`return ${name};`);
      }
    } else {
      const argList = args.map(a => `${a.name}: ${getZigType(a.type)}`);
      this.add(`fn ${name}(${argList.join(', ')}) ${getZigType(type)} {`);
      this.addStatements(statements);
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
    this.clearVariableAliases();
  }

  addVariableDeclaration({ type, name, initializer }) {
    const valueR = (initializer) ? this.translateExpression(initializer, type) : 'undefined';
    this.add(`var ${name}: ${getZigType(type)} = ${valueR};`);
    this.setVariableType(name, type);
  }

  addConstantDeclaration({ type, name, initializer }) {
    const valueR = this.translateExpression(initializer, type);
    this.add(`const ${name}: ${getZigType(type)} = ${valueR};`);
    this.setVariableType(name, type);
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

  translateVariableAccess({ names }) {
    const [ name, prop ] = names;
    const type = this.getVariableType(name);
    // in case the variable is aliased by a temporary variable
    const nameA = this.getVariableAlias(name);
    if (prop) {
      const indicesR = getSwizzleIndices(prop);
      const typeS = getSwizzleType(type, indicesR);
      if (indicesR.length > 1) {
        const typeCZ = getChildZigType(typeS);
        const mask = `@Vector(${indicesR.length}, i32){ ${indicesR.join(', ') } }`;
        return new ZigExpr(`@select(${typeCZ}, ${nameA}, undefined, ${mask})`, typeS);
      } else {
        const [ index ] = indicesR;
        return new ZigExpr(`${nameA}[${index}]`, typeS);
      }
    } else {
      return new ZigExpr(nameA, type);
    }
  }

  translateFunctionCall({ name, args }) {
    if (!this.hasFunction(name)) {
      const expanded = this.expandMacro(name, args);
      if (expanded) {
        return this.translateExpression(expanded);
      }
    }
    if (name === 'outCoord') {
      return new ZigExpr(`outCoord`, 'float2');
    } else if (name === 'sample') {
      name = 'sampleLinear';
    } else if (name === 'atan') {
      if (args.length === 2) {
        name = 'atan2';
      }
    }
    const argList = args.map(a => this.translateExpression(a));
    const type = this.getReturnValueType(name, argList);
    if (name === 'sampleNearest' || name === 'sampleLinear') {
      return new ZigExpr(`${argList[0]}.${name}(${argList[1]})`, type);
    } else {
      return new ZigExpr(`${name}(${argList.join(', ')})`, type);
    }
  }

  translateConstructorCall({ type, args }) {
    const argList = args.map(a => this.translateExpression(a, type));
    const width = getVectorWidth(type);
    if (width === 1) {
      const arg = argList[0];
      arg.convert(type);
      return arg;
    } else {
      const childType = getChildType(type);
      const typeZ = getZigType(type);
      argList.forEach(a => a.convert(childType));
      if (argList.length === 1) {
        const arg = argList[0];
        arg.promote(type);
        return arg;
      } else {
        return new ZigExpr(`${typeZ}{ ${argList.join(', ')} }`, type);
      }
    }
  }

  translateLiteralConstructorCall({ type, args }) {
    const argList = args.map(a => this.translateExpression(a, type));
    const width = getVectorWidth(type);
    if (width === 1) {
      const arg = argList[0];
      arg.convert(type);
      return arg;
    } else {
      const childType = getChildType(type);
      argList.forEach(a => a.convert(childType));
      if (argList.length === 1) {
        while (argList.length < width) {
          argList.push(argList[0]);
        }
      }
      return new ZigExpr(`.{ ${argList.join(', ')} }`, type);
    }
  }

  translateBinaryOperation({ operator, operand1, operand2 }, typeExpected) {
    switch (operator) {
      case '&&':
        operator = 'and';
        break;
      case '||':
        operator = 'or';
        break;
    };
    if (operator.endsWith('=')) {
      const [ nameL, propL ] = operand1.names;
      const typeL = this.getVariableType(nameL);
      if (propL) {
        // using vector write mask
        const indicesL = getSwizzleIndices(propL);
        if (indicesL.length > 1) {
          const typeS = getSwizzleType(typeL, indicesL);
          let valueR, indicesR;
          if (operand2 instanceof N.VariableAccess && operand2.names[1]) {
            // the right size has a mask too, get its indices
            const [ nameR, propR ] = operand2.names;
            const typeR = this.getVariableType(nameR);
            valueR = new ZigExpr(nameR, typeR);
            indicesR = getSwizzleIndices(propR);
          } else {
            // get the full vector and a list of sequential indices
            valueR = this.translateExpression(operand2, typeS) ;
            indicesR = getVectorIndices(typeS);
          }
          if (operator.length === 2) {
            // += and friends--need to perform the arithmetic operation first
            if (!valueR.isVector()) {
              valueR.promote(typeL);
            }
            valueR = new ZigExpr(`${nameL} ${operator.charAt(0)} ${valueR}`, typeL);
          }
          // build the shuffle mask
          const indicesM = [];
          const widthL = getVectorWidth(typeL);
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
          const typeCZ = getChildZigType(typeL);
          this.add(`${nameL} = @shuffle(${typeCZ}, ${nameL}, ${valueR}, ${mask1});`);
          if (typeExpected === 'void') {
            // the result isn't used, so it doesn't matter that the width is wrong
            return null;
          }
          const tmp = this.addTempVariable(nameL);
          const mask2 = `@Vector(${indicesL.length}, i32){ ${indicesL.join(', ') } }`;
          return new ZigExpr(`@select(${typeCZ}, ${tmp}, undefined, ${mask2})`, typeS);
        } else {
          const [ index ] = indicesL;
          const valueR = this.translateExpression(operand2, typeL);
          const childType = getChildType(typeL);
          this.add(`${nameL}[${index}] ${operator} ${valueR};`);
          if (typeExpected === 'void') {
            return null;
          }
          const tmp = this.addTempVariable(`${nameL}[${index}]`);
          return new ZigExpr(tmp, childType);
        }
      } else {
        const valueR = this.translateExpression(operand2, typeL);
        valueR.promote(typeL);
        this.add(`${nameL} ${operator} ${valueR};`);
        if (typeExpected === 'void') {
          return null;
        }
        const tmp = this.addTempVariable(nameL);
        return new ZigExpr(tmp, typeL);
      }
    } else {
      const opL = this.translateExpression(operand1);
      const opR = this.translateExpression(operand2);
      if (!opL.isVector() && opR.isVector()) {
        opL.promote(opR.type);
      } else if (opL.isVector() && !opR.isVector()) {
        opR.promote(opL.type);
      }
      return new ZigExpr(`${opL} ${operator} ${opR}`, opL.type);
    }
  }

  translateUnaryOperation({ operator, operand }) {
    const op = this.translateExpression(operand);
    return new ZigExpr(`${operator}${op}`, op.type);
  }

  translateParentheses({ expression }) {
    const expr = this.translateExpression(expression);
    if (/^\w+$/.test(expr)) {
      // don't need the parentheses
      return expr;
    }
    return new ZigExpr(`(${expr})`, expr.type);
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

  promote(type) {
    if (this.type !== type && !isVector(this.type)) {
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
          this.text = `@floatFromInt(${this.text})`;
        } else {
          this.text = getZigLiteral(value, type);
        }
      } else if (type === 'int') {
        const value = parseInt(this.text);
        if (isNaN(value)) {
          this.text = `@intFromFloat(${this.text})`;
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
  return isVector(type) ? type.slice(0, -1) : type;
}

function isVector(type) {
  return /^\w+\d$/.test(type);
}

function isMatrix(type) {
  return /^\w+\dx\d$/.test(type);
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

function snakeCase(s) {
  return s.replace(/\B([A-Z])/g, '_$1').toLowerCase();
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
  [ float, float, float ],
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
  min: [
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
  length: fx__fx,
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

