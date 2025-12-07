/**
 * EasyDynamicPrompts - 动态提示词构建器
 * SillyTavern 扩展入口
 *
 * 变量操作语法参考：Minecraft 指令 + JSON Patch (RFC 6902)
 */

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// 扩展基本信息
const extensionName = "EasyDynamicPrompts";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 默认设置
const defaultSettings = {
    enabled: true,
    autoUpdate: true,
    updateMode: 'streaming', // 'streaming' | 'background'
    templateSyntax: 'handlebars', // 'handlebars' | 'simple'
    debugMode: false,
};

// ==================== 工具函数 ====================

/**
 * 深拷贝对象
 */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * 路径解析器 - 支持点号和 JSON Pointer 格式
 */
class PathParser {
    /**
     * 解析路径为键数组
     * @param {string} path - 路径字符串
     * @returns {Array<string|number>} 键数组
     */
    static parse(path) {
        if (!path) return [];
        
        // JSON Pointer 格式 (/a/b/0)
        if (path.startsWith('/')) {
            return path.slice(1).split('/').map(key => {
                if (key === '-') return '-';
                const num = parseInt(key);
                return isNaN(num) ? key : num;
            });
        }
        
        // 点号格式 (a.b.0 或 a.b[0])
        return path
            .replace(/\[(\d+)\]/g, '.$1')
            .replace(/\[\-\]/g, '.-')
            .split('.')
            .filter(Boolean)
            .map(key => {
                if (key === '-') return '-';
                const num = parseInt(key);
                return isNaN(num) ? key : num;
            });
    }
    
    /**
     * 标准化路径为点号格式
     */
    static normalize(path) {
        const keys = this.parse(path);
        return keys.map(k => typeof k === 'number' ? `[${k}]` : k).join('.').replace(/\.\[/g, '[');
    }
}

// ==================== 条件校验器 ====================

/**
 * 条件校验器 - 评估条件表达式
 */
class ConditionEvaluator {
    constructor(variableManager) {
        this.vm = variableManager;
    }
    
    /**
     * 评估条件
     * @param {object} condition - 条件对象
     * @returns {boolean} 条件结果
     */
    evaluate(condition) {
        if (!condition) return true;
        
        // 逻辑组合
        if (condition.and) {
            return condition.and.every(c => this.evaluate(c));
        }
        if (condition.or) {
            return condition.or.some(c => this.evaluate(c));
        }
        if (condition.not) {
            return !this.evaluate(condition.not);
        }
        
        // 简单条件
        const value = this.vm.get(condition.path);
        
        // 存在性检查
        if ('exists' in condition) {
            const exists = value !== undefined && value !== null;
            return condition.exists ? exists : !exists;
        }
        
        // 比较操作
        if ('eq' in condition) return value === condition.eq;
        if ('neq' in condition) return value !== condition.neq;
        if ('gt' in condition) return typeof value === 'number' && value > condition.gt;
        if ('gte' in condition) return typeof value === 'number' && value >= condition.gte;
        if ('lt' in condition) return typeof value === 'number' && value < condition.lt;
        if ('lte' in condition) return typeof value === 'number' && value <= condition.lte;
        
        // 数组包含检查
        if ('in' in condition) return Array.isArray(condition.in) && condition.in.includes(value);
        if ('nin' in condition) return Array.isArray(condition.nin) && !condition.nin.includes(value);
        
        // 正则匹配
        if ('match' in condition) {
            try {
                const regex = new RegExp(condition.match);
                return typeof value === 'string' && regex.test(value);
            } catch {
                return false;
            }
        }
        
        // 值相等检查
        if ('value' in condition) return value === condition.value;
        
        return Boolean(value);
    }
}

// ==================== 模式校验器 ====================

/**
 * 模式校验器 - 实现 $meta 保护机制
 * 参考 MVU 的 $meta 设计，保护变量结构
 */
class SchemaValidator {
    constructor(variableManager) {
        this.vm = variableManager;
    }
    
    /**
     * 校验操作是否合法
     * @param {object} operation - 操作对象
     * @returns {{ valid: boolean, error?: string }}
     */
    validate(operation) {
        const { op, path, value, from } = operation;
        
        // 获取目标路径的 $meta
        const meta = this._getMetaForPath(path);
        
        // 如果没有 $meta，默认允许所有操作
        if (!meta) {
            return { valid: true };
        }
        
        switch (op) {
            case 'add':
            case 'replace':
                return this._validateAddOrReplace(path, value, meta);
            case 'remove':
                return this._validateRemove(path, meta);
            case 'move':
            case 'copy':
                // 检查源和目标
                const fromMeta = this._getMetaForPath(from);
                if (fromMeta && op === 'move') {
                    const removeCheck = this._validateRemove(from, fromMeta);
                    if (!removeCheck.valid) return removeCheck;
                }
                return this._validateAddOrReplace(path, this.vm.get(from), meta);
            default:
                return { valid: true };
        }
    }
    
    /**
     * 获取路径对应的 $meta
     */
    _getMetaForPath(path) {
        const keys = PathParser.parse(path);
        if (keys.length === 0) return null;
        
        // 逐级查找 $meta
        let current = this.vm.statData;
        let lastMeta = null;
        
        for (let i = 0; i < keys.length; i++) {
            if (current === undefined || current === null) break;
            
            // 检查当前层级的 $meta
            if (typeof current === 'object' && current.$meta) {
                lastMeta = current.$meta;
                
                // 如果是递归可扩展，记住这个 meta
                if (current.$meta.recursiveExtensible) {
                    // 继续使用这个 meta
                }
            }
            
            const key = keys[i];
            if (typeof key === 'number' && Array.isArray(current)) {
                current = current[key];
            } else if (typeof current === 'object') {
                current = current[key];
            } else {
                break;
            }
        }
        
        // 返回最近找到的 $meta
        return lastMeta;
    }
    
    /**
     * 校验添加/替换操作
     */
    _validateAddOrReplace(path, value, meta) {
        const keys = PathParser.parse(path);
        const targetKey = keys[keys.length - 1];
        const parentPath = keys.slice(0, -1).join('.');
        const parent = parentPath ? this.vm.get(parentPath) : this.vm.statData;
        
        // 检查是否可扩展
        if (meta.extensible === false) {
            // 检查目标键是否已存在
            if (parent && typeof parent === 'object') {
                if (!(targetKey in parent)) {
                    return { valid: false, error: `[Schema] 路径 ${parentPath || 'root'} 不可扩展，不能添加新键 "${targetKey}"` };
                }
            }
        }
        
        // 检查必需键（如果是替换整个对象）
        if (meta.required && typeof value === 'object' && value !== null) {
            for (const reqKey of meta.required) {
                if (!(reqKey in value)) {
                    return { valid: false, error: `[Schema] 缺少必需键 "${reqKey}"` };
                }
            }
        }
        
        // 如果有模板，检查值的结构是否符合
        if (meta.template && typeof value === 'object' && value !== null) {
            const templateKeys = Object.keys(meta.template);
            for (const tKey of templateKeys) {
                if (meta.template[tKey] !== null && !(tKey in value)) {
                    // 模板中非 null 的键必须存在
                    // 可以选择自动添加或报错
                }
            }
        }
        
        return { valid: true };
    }
    
    /**
     * 校验删除操作
     */
    _validateRemove(path, meta) {
        const keys = PathParser.parse(path);
        const targetKey = keys[keys.length - 1];
        
        // 检查是否是必需键
        if (meta.required && meta.required.includes(targetKey)) {
            return { valid: false, error: `[Schema] 不能删除必需键 "${targetKey}"` };
        }
        
        return { valid: true };
    }
    
    /**
     * 根据模板创建新对象
     * @param {string} path - 目标路径
     * @returns {object|null} 根据模板创建的对象
     */
    createFromTemplate(path) {
        const meta = this._getMetaForPath(path);
        if (!meta || !meta.template) return null;
        
        return deepClone(meta.template);
    }
    
    /**
     * 注册模式（设置 $meta）
     * @param {string} path - 路径
     * @param {object} schema - 模式配置
     */
    registerSchema(path, schema) {
        const target = path ? this.vm.get(path) : this.vm.statData;
        if (target && typeof target === 'object') {
            target.$meta = schema;
        }
    }
    
    /**
     * 批量注册模式
     * @param {Array} schemas - 模式数组 [{ path, schema }]
     */
    registerSchemas(schemas) {
        for (const { path, schema } of schemas) {
            this.registerSchema(path, schema);
        }
    }
}

// ==================== 表达式计算引擎 ====================

/**
 * 计算引擎 - 支持变量间运算 (Minecraft scoreboard operation 风格)
 */
class CalcEngine {
    constructor(variableManager) {
        this.vm = variableManager;
    }
    
    /**
     * 计算表达式
     * @param {string} expr - 表达式字符串
     * @returns {number|null} 计算结果
     */
    evaluate(expr) {
        try {
            const resolvedExpr = this._resolveVariables(expr);
            return this._safeEval(resolvedExpr);
        } catch (e) {
            console.warn(`[EDP] 表达式计算失败: ${expr}`, e);
            return null;
        }
    }
    
    _resolveVariables(expr) {
        const varPattern = /([a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_.\u4e00-\u9fa5]*)/g;
        return expr.replace(varPattern, (match) => {
            if (/^\d+(\.\d+)?$/.test(match)) return match;
            const value = this.vm.get(match);
            if (typeof value === 'number') return value;
            if (value === undefined || value === null) return 0;
            return value;
        });
    }
    
    _safeEval(expr) {
        if (!/^[\d\s+\-*/%().]+$/.test(expr)) {
            throw new Error(`不安全的表达式: ${expr}`);
        }
        return new Function(`return (${expr})`)();
    }
}

// ==================== 操作执行器 ====================

/**
 * 操作执行器 - 执行 JSON Patch 风格的操作
 */
class OperationExecutor {
    constructor(variableManager) {
        this.vm = variableManager;
        this.conditionEvaluator = new ConditionEvaluator(variableManager);
        this.calcEngine = new CalcEngine(variableManager);
        this.schemaValidator = new SchemaValidator(variableManager);
    }
    
    /**
     * 执行单个操作
     * @param {object} operation - 操作对象
     * @returns {{ success: boolean, error?: string, skipped?: boolean }}
     */
    execute(operation) {
        const { op, path, value, from, delta, expr, action, index } = operation;
        
        // 条件检查
        if (operation.if && !this.conditionEvaluator.evaluate(operation.if)) {
            return { success: true, skipped: true };
        }
        
        // 模式校验（如果启用）
        if (this.vm.schemaValidationEnabled) {
            const validation = this.schemaValidator.validate(operation);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }
        
        try {
            switch (op) {
                case 'add': return this._executeAdd(path, value);
                case 'remove': return this._executeRemove(path);
                case 'replace': return this._executeReplace(path, value);
                case 'move': return this._executeMove(from, path);
                case 'copy': return this._executeCopy(from, path);
                case 'test': return this._executeTest(operation);
                case 'increment': return this._executeIncrement(path, delta);
                case 'calc': return this._executeCalc(path, expr);
                case 'modify': return this._executeModify(path, action, value, index);
                default: return { success: false, error: `未知操作: ${op}` };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    
    _executeAdd(path, value) {
        const keys = PathParser.parse(path);
        const lastKey = keys[keys.length - 1];
        
        if (lastKey === '-') {
            const parentPath = keys.slice(0, -1).join('.');
            const target = this.vm._getByPath(this.vm.statData, parentPath);
            if (!Array.isArray(target)) {
                return { success: false, error: `${path} 的父节点不是数组` };
            }
            target.push(value);
        } else if (typeof lastKey === 'number') {
            const parentPath = keys.slice(0, -1).join('.');
            const target = this.vm._getByPath(this.vm.statData, parentPath);
            if (!Array.isArray(target)) {
                return { success: false, error: `${path} 的父节点不是数组` };
            }
            target.splice(lastKey, 0, value);
        } else {
            this.vm._setByPath(this.vm.statData, path, value);
        }
        
        this.vm._emitChange(path, undefined, value, 'add');
        return { success: true };
    }
    
    _executeRemove(path) {
        const oldValue = this.vm.get(path);
        const keys = PathParser.parse(path);
        const lastKey = keys[keys.length - 1];
        
        if (typeof lastKey === 'number') {
            const parentPath = keys.slice(0, -1).join('.');
            const target = this.vm._getByPath(this.vm.statData, parentPath);
            if (Array.isArray(target)) target.splice(lastKey, 1);
        } else {
            this.vm._deleteByPath(this.vm.statData, path);
        }
        
        this.vm._emitChange(path, oldValue, undefined, 'remove');
        return { success: true };
    }
    
    _executeReplace(path, value) {
        const oldValue = this.vm.get(path);
        this.vm._setByPath(this.vm.statData, path, value);
        this.vm._emitChange(path, oldValue, value, 'replace');
        return { success: true };
    }
    
    _executeMove(from, path) {
        const value = this.vm.get(from);
        if (value === undefined) {
            return { success: false, error: `源路径不存在: ${from}` };
        }
        this._executeRemove(from);
        return this._executeAdd(path, value);
    }
    
    _executeCopy(from, path) {
        const value = this.vm.get(from);
        if (value === undefined) {
            return { success: false, error: `源路径不存在: ${from}` };
        }
        return this._executeAdd(path, deepClone(value));
    }
    
    _executeTest(operation) {
        const { path, value } = operation;
        const currentValue = this.vm.get(path);
        
        if ('value' in operation) {
            if (JSON.stringify(currentValue) !== JSON.stringify(value)) {
                return { success: false, error: `test 失败: ${path}` };
            }
        } else {
            const condition = { path, ...operation };
            delete condition.op;
            if (!this.conditionEvaluator.evaluate(condition)) {
                return { success: false, error: `test 条件不满足: ${path}` };
            }
        }
        return { success: true };
    }
    
    _executeIncrement(path, delta) {
        const oldValue = this.vm.get(path);
        if (typeof oldValue !== 'number' && oldValue !== undefined) {
            return { success: false, error: `increment: ${path} 不是数值` };
        }
        const newValue = (oldValue || 0) + delta;
        this.vm._setByPath(this.vm.statData, path, newValue);
        this.vm._emitChange(path, oldValue, newValue, `${delta > 0 ? '+' : ''}${delta}`);
        return { success: true };
    }
    
    _executeCalc(path, expr) {
        const result = this.calcEngine.evaluate(expr);
        if (result === null) {
            return { success: false, error: `calc 计算失败: ${expr}` };
        }
        const oldValue = this.vm.get(path);
        this.vm._setByPath(this.vm.statData, path, result);
        this.vm._emitChange(path, oldValue, result, `calc: ${expr}`);
        return { success: true };
    }
    
    _executeModify(path, action, value, index) {
        const target = this.vm.get(path);
        
        if (Array.isArray(target)) {
            switch (action) {
                case 'append': target.push(value); break;
                case 'prepend': target.unshift(value); break;
                case 'insert':
                    if (typeof index !== 'number') return { success: false, error: 'insert 需要 index' };
                    target.splice(index, 0, value);
                    break;
                case 'merge':
                    if (Array.isArray(value)) target.push(...value);
                    else return { success: false, error: 'merge 值必须是数组' };
                    break;
                default: return { success: false, error: `未知 action: ${action}` };
            }
        } else if (typeof target === 'object' && target !== null) {
            if (action === 'merge' && typeof value === 'object') Object.assign(target, value);
            else return { success: false, error: '对象只支持 merge' };
        } else {
            return { success: false, error: `${path} 不是数组或对象` };
        }
        
        this.vm._emitChange(path, '[modified]', target, `modify:${action}`);
        return { success: true };
    }
}

// ==================== 批量执行器 ====================

/**
 * 批量执行器 - 支持原子操作
 */
class BatchExecutor {
    constructor(variableManager) {
        this.vm = variableManager;
        this.executor = new OperationExecutor(variableManager);
    }
    
    /**
     * 批量执行操作
     * @param {Array} operations - 操作数组
     * @param {object} options - { atomic: boolean }
     */
    execute(operations, options = {}) {
        const { atomic = false } = options;
        const results = [];
        const errors = [];
        
        let snapshot = atomic ? deepClone(this.vm.statData) : null;
        
        for (let i = 0; i < operations.length; i++) {
            const result = this.executor.execute(operations[i]);
            results.push(result);
            
            if (!result.success && !result.skipped) {
                errors.push({ index: i, operation: operations[i], error: result.error });
                if (atomic) {
                    this.vm.statData = snapshot;
                    return { success: false, results, errors, rollback: true };
                }
            }
        }
        
        return { success: errors.length === 0, results, errors };
    }
}

// ==================== 核心类 ====================

/**
 * 变量管理器 - 管理动态变量的CRUD操作
 */
class VariableManager {
    constructor() {
        this.statData = {};
        this.displayData = {};
        this.deltaData = {};
        this.schema = null;
        this.executor = null;
        this.batchExecutor = null;
        this.schemaValidator = null;
        this.schemaValidationEnabled = false; // 默认关闭模式校验
    }
    
    /**
     * 初始化执行器（延迟初始化避免循环依赖）
     */
    _initExecutors() {
        if (!this.executor) {
            this.executor = new OperationExecutor(this);
            this.batchExecutor = new BatchExecutor(this);
            this.schemaValidator = new SchemaValidator(this);
        }
    }
    
    /**
     * 启用/禁用模式校验
     */
    setSchemaValidation(enabled) {
        this.schemaValidationEnabled = enabled;
    }
    
    /**
     * 注册模式
     * @param {string} path - 路径
     * @param {object} schema - 模式配置 { extensible, required, recursiveExtensible, template }
     */
    registerSchema(path, schema) {
        this._initExecutors();
        this.schemaValidator.registerSchema(path, schema);
    }
    
    /**
     * 批量注册模式
     */
    registerSchemas(schemas) {
        this._initExecutors();
        this.schemaValidator.registerSchemas(schemas);
    }
    
    /**
     * 根据模板创建新对象
     */
    createFromTemplate(path) {
        this._initExecutors();
        return this.schemaValidator.createFromTemplate(path);
    }

    /**
     * 获取变量值
     */
    get(path, options = {}) {
        const { defaultValue = undefined, source = 'stat' } = options;
        const dataSource = source === 'display' ? this.displayData :
                          source === 'delta' ? this.deltaData : this.statData;
        
        const value = this._getByPath(dataSource, path);
        
        if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') {
            return value[0];
        }
        
        return value !== undefined ? value : defaultValue;
    }

    /**
     * 设置变量值（简化语法，支持 test 选项）
     */
    set(path, value, options = {}) {
        this._initExecutors();
        const { test } = options;
        
        if (test !== undefined) {
            const testResult = this.executor.execute({ op: 'test', path, value: test });
            if (!testResult.success) {
                console.warn(`[EDP] 旧值校验失败`);
                return false;
            }
        }
        
        return this.executor.execute({ op: 'replace', path, value }).success;
    }

    /**
     * 数值增量更新（简化语法）
     */
    add(path, delta, reason = '') {
        this._initExecutors();
        return this.executor.execute({ op: 'increment', path, delta }).success;
    }
    
    /** 别名 */
    increment(path, delta, reason = '') {
        return this.add(path, delta, reason);
    }

    /**
     * 向数组尾部追加（简化语法）
     */
    push(path, value) {
        this._initExecutors();
        return this.executor.execute({ op: 'add', path: `${path}/-`, value }).success;
    }
    
    /**
     * 数组指定位置插入（简化语法）
     */
    insert(path, index, value) {
        this._initExecutors();
        return this.executor.execute({ op: 'add', path: `${path}.${index}`, value }).success;
    }

    /**
     * 向数组/对象添加元素（向后兼容旧语法）
     */
    assign(path, keyOrValue, value = undefined) {
        if (value === undefined) {
            return this.push(path, keyOrValue);
        } else if (typeof keyOrValue === 'number') {
            return this.insert(path, keyOrValue, value);
        } else {
            return this.set(`${path}.${keyOrValue}`, value);
        }
    }

    /**
     * 删除变量或元素（简化语法）
     */
    remove(path, keyOrIndex = undefined) {
        this._initExecutors();
        const targetPath = keyOrIndex !== undefined ? `${path}.${keyOrIndex}` : path;
        return this.executor.execute({ op: 'remove', path: targetPath }).success;
    }
    
    /**
     * 移动变量（新增）
     */
    move(from, to) {
        this._initExecutors();
        return this.executor.execute({ op: 'move', from, path: to }).success;
    }
    
    /**
     * 复制变量（新增）
     */
    copy(from, to) {
        this._initExecutors();
        return this.executor.execute({ op: 'copy', from, path: to }).success;
    }
    
    /**
     * 变量间运算（新增，Minecraft 风格）
     */
    calc(path, expr) {
        this._initExecutors();
        return this.executor.execute({ op: 'calc', path, expr }).success;
    }
    
    /**
     * 数组/对象修改（新增，Minecraft data modify 风格）
     */
    modify(path, action, value, index = undefined) {
        this._initExecutors();
        return this.executor.execute({ op: 'modify', path, action, value, index }).success;
    }
    
    /**
     * 执行单个操作（JSON Patch 风格）
     */
    op(operation) {
        this._initExecutors();
        return this.executor.execute(operation);
    }
    
    /**
     * 批量执行操作（JSON Patch 风格，支持原子操作）
     */
    batch(operations, options = {}) {
        this._initExecutors();
        return this.batchExecutor.execute(operations, options);
    }

    clearDelta() {
        this.deltaData = {};
    }

    export() {
        return {
            stat_data: deepClone(this.statData),
            display_data: deepClone(this.displayData),
            delta_data: deepClone(this.deltaData),
        };
    }

    import(data) {
        if (data.stat_data) this.statData = data.stat_data;
        if (data.display_data) this.displayData = data.display_data;
        if (data.delta_data) this.deltaData = data.delta_data;
    }

    // ========== 私有方法 ==========

    _getByPath(obj, path) {
        if (!path) return obj;
        const keys = PathParser.parse(path);
        let current = obj;
        for (const key of keys) {
            if (current === undefined || current === null) return undefined;
            if (key === '-' && Array.isArray(current)) return current[current.length - 1];
            current = current[key];
        }
        return current;
    }

    _setByPath(obj, path, value) {
        const keys = PathParser.parse(path);
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (current[key] === undefined) {
                const nextKey = keys[i + 1];
                current[key] = (typeof nextKey === 'number' || nextKey === '-') ? [] : {};
            }
            current = current[key];
        }
        const lastKey = keys[keys.length - 1];
        if (lastKey === '-' && Array.isArray(current)) {
            current.push(value);
        } else {
            current[lastKey] = value;
        }
    }

    _deleteByPath(obj, path) {
        const keys = PathParser.parse(path);
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            if (current[keys[i]] === undefined) return false;
            current = current[keys[i]];
        }
        const lastKey = keys[keys.length - 1];
        if (Array.isArray(current) && typeof lastKey === 'number') {
            current.splice(lastKey, 1);
        } else {
            delete current[lastKey];
        }
        return true;
    }

    _emitChange(path, oldValue, newValue, reason) {
        const displayValue = reason ?
            `${oldValue} → ${newValue} (${reason})` :
            `${oldValue} → ${newValue}`;
        this._setByPath(this.displayData, path, displayValue);
        this._setByPath(this.deltaData, path, displayValue);
        
        const event = new CustomEvent('edp_variable_changed', {
            detail: { path, oldValue, newValue, reason }
        });
        document.dispatchEvent(event);
    }
}

/**
 * 更新语句解析器 - 解析 AI 回复中的变量更新命令
 * 支持三种格式：
 * 1. JSON 块格式：<UpdateVariable>[...]</UpdateVariable>
 * 2. Minecraft 风格命令：/data set <path> <value>
 * 3. 函数调用格式（向后兼容）：_.set('path', value)
 */
class UpdateParser {
    constructor() {
        // JSON 块匹配
        this.jsonBlockPattern = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;
        
        // Minecraft 风格 /data 命令（主要格式）
        this.dataCommands = {
            // /data set <path> <value> [test <oldValue>]
            set: /\/data\s+set\s+(\S+)\s+(.+?)(?:\s+test\s+(.+))?$/gm,
            // /data add <path> <delta>
            add: /\/data\s+add\s+(\S+)\s+([+-]?\d+(?:\.\d+)?)/gm,
            // /data push <path> <value>
            push: /\/data\s+push\s+(\S+)\s+(.+)/gm,
            // /data insert <path> <index> <value>
            insert: /\/data\s+insert\s+(\S+)\s+(\d+)\s+(.+)/gm,
            // /data remove <path>
            remove: /\/data\s+remove\s+(\S+)/gm,
            // /data move <from> <to>
            move: /\/data\s+move\s+(\S+)\s+(\S+)/gm,
            // /data copy <from> <to>
            copy: /\/data\s+copy\s+(\S+)\s+(\S+)/gm,
            // /data calc <path> <expr>
            calc: /\/data\s+calc\s+(\S+)\s+"([^"]+)"/gm,
            // /data modify <path> <action> <value>
            modify: /\/data\s+modify\s+(\S+)\s+(append|prepend|insert|merge)\s+(.+)/gm,
            // /data test <path> <condition>
            test: /\/data\s+test\s+(\S+)\s+(eq|neq|gt|gte|lt|lte|exists)\s*(.*)?/gm,
        };
        
        // 函数调用格式（向后兼容）
        this.legacyPatterns = {
            set: /\_\.set\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^,)]+)(?:\s*,\s*(\{[^}]+\}))?\s*\)/g,
            add: /\_\.add\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\s*\)/g,
            push: /\_\.push\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\s*\)/g,
            insert: /\_\.insert\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*([^)]+)\s*\)/g,
            remove: /\_\.remove\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\s*\)/g,
            move: /\_\.move\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g,
            copy: /\_\.copy\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g,
            calc: /\_\.calc\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g,
            modify: /\_\.modify\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"](\w+)['"]\s*,\s*([^)]+)\s*\)/g,
            op: /\_\.op\s*\(\s*(\{[\s\S]*?\})\s*\)/g,
            batch: /\_\.batch\s*\(\s*(\[[\s\S]*?\])(?:\s*,\s*(\{[^}]*\}))?\s*\)/g,
            assign: /\_\.assign\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^,)]+)\s*)?(?:,\s*([^)]+))?\s*\)/g,
        };
    }

    /**
     * 从文本中解析所有更新命令
     * @param {string} text - 包含更新命令的文本
     * @returns {Array} 解析出的操作列表（JSON Patch 格式）
     */
    parse(text) {
        const operations = [];
        
        // 1. 解析 JSON 块格式
        operations.push(...this._parseJsonBlocks(text));
        
        // 2. 解析 /data 命令格式（主要）
        operations.push(...this._parseDataCommands(text));
        
        // 3. 解析旧的函数调用格式（向后兼容）
        operations.push(...this._parseLegacyCommands(text));
        
        return operations;
    }
    
    /**
     * 解析 JSON 块
     */
    _parseJsonBlocks(text) {
        const operations = [];
        let match;
        
        const pattern = new RegExp(this.jsonBlockPattern.source, 'gi');
        while ((match = pattern.exec(text)) !== null) {
            try {
                const json = match[1].trim();
                const parsed = JSON.parse(json);
                if (Array.isArray(parsed)) {
                    operations.push(...parsed);
                } else if (parsed && typeof parsed === 'object') {
                    operations.push(parsed);
                }
            } catch (e) {
                console.warn('[EDP] JSON 块解析失败:', e.message);
            }
        }
        
        return operations;
    }
    
    /**
     * 解析 /data 命令（Minecraft 风格）
     */
    _parseDataCommands(text) {
        const operations = [];
        let match;
        
        // /data set <path> <value> [test <oldValue>]
        const setPattern = new RegExp(this.dataCommands.set.source, 'gm');
        while ((match = setPattern.exec(text)) !== null) {
            if (match[3]) {
                operations.push({ op: 'test', path: match[1], value: this._parseValue(match[3].trim()) });
            }
            operations.push({ op: 'replace', path: match[1], value: this._parseValue(match[2].trim()) });
        }
        
        // /data add <path> <delta>
        const addPattern = new RegExp(this.dataCommands.add.source, 'gm');
        while ((match = addPattern.exec(text)) !== null) {
            operations.push({ op: 'increment', path: match[1], delta: parseFloat(match[2]) });
        }
        
        // /data push <path> <value>
        const pushPattern = new RegExp(this.dataCommands.push.source, 'gm');
        while ((match = pushPattern.exec(text)) !== null) {
            operations.push({ op: 'add', path: `${match[1]}/-`, value: this._parseValue(match[2].trim()) });
        }
        
        // /data insert <path> <index> <value>
        const insertPattern = new RegExp(this.dataCommands.insert.source, 'gm');
        while ((match = insertPattern.exec(text)) !== null) {
            operations.push({ op: 'add', path: `${match[1]}.${match[2]}`, value: this._parseValue(match[3].trim()) });
        }
        
        // /data remove <path>
        const removePattern = new RegExp(this.dataCommands.remove.source, 'gm');
        while ((match = removePattern.exec(text)) !== null) {
            operations.push({ op: 'remove', path: match[1] });
        }
        
        // /data move <from> <to>
        const movePattern = new RegExp(this.dataCommands.move.source, 'gm');
        while ((match = movePattern.exec(text)) !== null) {
            operations.push({ op: 'move', from: match[1], path: match[2] });
        }
        
        // /data copy <from> <to>
        const copyPattern = new RegExp(this.dataCommands.copy.source, 'gm');
        while ((match = copyPattern.exec(text)) !== null) {
            operations.push({ op: 'copy', from: match[1], path: match[2] });
        }
        
        // /data calc <path> "<expr>"
        const calcPattern = new RegExp(this.dataCommands.calc.source, 'gm');
        while ((match = calcPattern.exec(text)) !== null) {
            operations.push({ op: 'calc', path: match[1], expr: match[2] });
        }
        
        // /data modify <path> <action> <value>
        const modifyPattern = new RegExp(this.dataCommands.modify.source, 'gm');
        while ((match = modifyPattern.exec(text)) !== null) {
            operations.push({ op: 'modify', path: match[1], action: match[2], value: this._parseValue(match[3].trim()) });
        }
        
        // /data test <path> <condition> [value]
        const testPattern = new RegExp(this.dataCommands.test.source, 'gm');
        while ((match = testPattern.exec(text)) !== null) {
            const condition = match[2];
            const testOp = { op: 'test', path: match[1] };
            
            if (condition === 'exists') {
                testOp.exists = true;
            } else if (match[3]) {
                testOp[condition] = this._parseValue(match[3].trim());
            }
            
            operations.push(testOp);
        }
        
        return operations;
    }
    
    /**
     * 解析旧的函数调用格式（向后兼容）
     */
    _parseLegacyCommands(text) {
        const operations = [];
        let match;
        
        // _.set('path', value) 或 _.set('path', value, {test: old})
        const setPattern = new RegExp(this.legacyPatterns.set.source, 'g');
        while ((match = setPattern.exec(text)) !== null) {
            if (match[3]) {
                try {
                    const opts = JSON.parse(match[3].replace(/'/g, '"'));
                    if (opts.test !== undefined) {
                        operations.push({ op: 'test', path: match[1], value: opts.test });
                    }
                } catch {}
            }
            operations.push({ op: 'replace', path: match[1], value: this._parseValue(match[2]) });
        }
        
        // _.add('path', delta)
        const addPattern = new RegExp(this.legacyPatterns.add.source, 'g');
        while ((match = addPattern.exec(text)) !== null) {
            operations.push({ op: 'increment', path: match[1], delta: this._parseValue(match[2]) });
        }
        
        // _.push('path', value)
        const pushPattern = new RegExp(this.legacyPatterns.push.source, 'g');
        while ((match = pushPattern.exec(text)) !== null) {
            operations.push({ op: 'add', path: `${match[1]}/-`, value: this._parseValue(match[2]) });
        }
        
        // _.insert('path', index, value)
        const insertPattern = new RegExp(this.legacyPatterns.insert.source, 'g');
        while ((match = insertPattern.exec(text)) !== null) {
            operations.push({ op: 'add', path: `${match[1]}.${match[2]}`, value: this._parseValue(match[3]) });
        }
        
        // _.remove('path') 或 _.remove('path', key)
        const removePattern = new RegExp(this.legacyPatterns.remove.source, 'g');
        while ((match = removePattern.exec(text)) !== null) {
            const path = match[2] ? `${match[1]}.${this._parseValue(match[2])}` : match[1];
            operations.push({ op: 'remove', path });
        }
        
        // _.move('from', 'to')
        const movePattern = new RegExp(this.legacyPatterns.move.source, 'g');
        while ((match = movePattern.exec(text)) !== null) {
            operations.push({ op: 'move', from: match[1], path: match[2] });
        }
        
        // _.copy('from', 'to')
        const copyPattern = new RegExp(this.legacyPatterns.copy.source, 'g');
        while ((match = copyPattern.exec(text)) !== null) {
            operations.push({ op: 'copy', from: match[1], path: match[2] });
        }
        
        // _.calc('path', 'expr')
        const calcPattern = new RegExp(this.legacyPatterns.calc.source, 'g');
        while ((match = calcPattern.exec(text)) !== null) {
            operations.push({ op: 'calc', path: match[1], expr: match[2] });
        }
        
        // _.modify('path', 'action', value)
        const modifyPattern = new RegExp(this.legacyPatterns.modify.source, 'g');
        while ((match = modifyPattern.exec(text)) !== null) {
            operations.push({ op: 'modify', path: match[1], action: match[2], value: this._parseValue(match[3]) });
        }
        
        // _.op({...})
        const opPattern = new RegExp(this.legacyPatterns.op.source, 'g');
        while ((match = opPattern.exec(text)) !== null) {
            try {
                const op = JSON.parse(match[1].replace(/'/g, '"'));
                operations.push(op);
            } catch {}
        }
        
        // _.batch([...])
        const batchPattern = new RegExp(this.legacyPatterns.batch.source, 'g');
        while ((match = batchPattern.exec(text)) !== null) {
            try {
                const ops = JSON.parse(match[1].replace(/'/g, '"'));
                if (Array.isArray(ops)) {
                    ops.forEach(op => { op._batch = true; });
                    if (match[2]) {
                        try { ops._options = JSON.parse(match[2].replace(/'/g, '"')); } catch {}
                    }
                    operations.push(...ops);
                }
            } catch {}
        }
        
        // _.assign('path', value) - 向后兼容
        const assignPattern = new RegExp(this.legacyPatterns.assign.source, 'g');
        while ((match = assignPattern.exec(text)) !== null) {
            if (match[3] !== undefined) {
                const key = this._parseValue(match[2]);
                operations.push({ op: 'replace', path: `${match[1]}.${key}`, value: this._parseValue(match[3]) });
            } else if (match[2] !== undefined) {
                operations.push({ op: 'add', path: `${match[1]}/-`, value: this._parseValue(match[2]) });
            }
        }
        
        return operations;
    }

    /**
     * 解析值（字符串/数字/布尔/对象）
     */
    _parseValue(str) {
        if (!str) return undefined;
        str = str.trim();
        
        try {
            return JSON.parse(str);
        } catch {
            if ((str.startsWith("'") && str.endsWith("'")) ||
                (str.startsWith('"') && str.endsWith('"'))) {
                return str.slice(1, -1);
            }
            const num = parseFloat(str);
            if (!isNaN(num)) return num;
            return str;
        }
    }
    
    /**
     * 执行解析出的操作
     * @param {VariableManager} vm - 变量管理器
     * @param {Array} operations - 操作数组
     * @returns {Array} 执行结果数组
     */
    executeAll(vm, operations) {
        const results = [];
        let batchOps = [];
        let batchOptions = {};
        
        for (const op of operations) {
            if (op._batch) {
                delete op._batch;
                batchOps.push(op);
                if (op._options) {
                    batchOptions = op._options;
                    delete op._options;
                }
                continue;
            }
            
            if (batchOps.length > 0) {
                results.push(vm.batch(batchOps, batchOptions));
                batchOps = [];
                batchOptions = {};
            }
            
            results.push(vm.op(op));
        }
        
        if (batchOps.length > 0) {
            results.push(vm.batch(batchOps, batchOptions));
        }
        
        return results;
    }
}

/**
 * 模板引擎 - 支持 Handlebars 风格语法
 */
class TemplateEngine {
    constructor(variableManager) {
        this.variableManager = variableManager;
        this.templates = new Map();
        this.cache = new Map();
        this.maxNestingDepth = 10; // 防止无限递归
    }

    /**
     * 注册模板
     */
    registerTemplate(id, template) {
        this.templates.set(id, template);
        this.cache.delete(id);
    }
    
    /**
     * 批量注册模板
     */
    registerTemplates(templates) {
        for (const template of templates) {
            this.registerTemplate(template.id, template);
        }
    }
    
    /**
     * 获取模板
     */
    getTemplate(id) {
        return this.templates.get(id);
    }
    
    /**
     * 获取所有模板
     */
    getAllTemplates() {
        return Array.from(this.templates.values());
    }
    
    /**
     * 删除模板
     */
    deleteTemplate(id) {
        this.templates.delete(id);
        this.cache.delete(id);
    }

    /**
     * 渲染模板
     * @param {string} templateId - 模板 ID
     * @param {object} context - 额外上下文
     * @returns {string} 渲染结果
     */
    render(templateId, context = {}) {
        const template = this.templates.get(templateId);
        if (!template) {
            console.warn(`[EDP] 模板不存在: ${templateId}`);
            return '';
        }
        return this.renderString(template.content, context, 0);
    }

    /**
     * 渲染模板字符串
     * @param {string} templateStr - 模板字符串
     * @param {object} context - 上下文
     * @param {number} depth - 当前嵌套深度
     */
    renderString(templateStr, context = {}, depth = 0) {
        if (depth > this.maxNestingDepth) {
            console.warn('[EDP] 模板嵌套深度超限');
            return templateStr;
        }
        
        let result = templateStr;
        
        // 1. 处理嵌套模板 {{> templateId}} 或 {{> templateId param1=value1}}
        result = this._processNestedTemplates(result, context, depth);
        
        // 2. 处理条件块 {{#if condition}}...{{else}}...{{/if}}
        result = this._processConditionals(result, context, depth);
        
        // 3. 处理循环 {{#each array as item}}...{{/each}}
        result = this._processLoops(result, context, depth);
        
        // 4. 处理 switch {{#switch path}}{{#case value}}...{{/case}}{{/switch}}
        result = this._processSwitch(result, context, depth);
        
        // 5. 处理变量插值 {{path}} 或 {{path | filter}}
        result = this._processVariables(result, context);
        
        return result;
    }
    
    /**
     * 处理嵌套模板 {{> templateId param=value}}
     */
    _processNestedTemplates(str, context, depth) {
        // 匹配 {{> templateId}} 或 {{> templateId key=value key2=value2}}
        const partialPattern = /\{\{>\s*([^\s}]+)(?:\s+([^}]*))?\}\}/g;
        
        return str.replace(partialPattern, (match, templateId, paramsStr) => {
            const template = this.templates.get(templateId);
            if (!template) {
                console.warn(`[EDP] 嵌套模板不存在: ${templateId}`);
                return '';
            }
            
            // 解析参数
            const params = this._parseParams(paramsStr || '');
            const nestedContext = { ...context, ...params };
            
            return this.renderString(template.content, nestedContext, depth + 1);
        });
    }
    
    /**
     * 解析模板参数 key=value key2="value 2"
     */
    _parseParams(paramsStr) {
        const params = {};
        const paramPattern = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        let match;
        
        while ((match = paramPattern.exec(paramsStr)) !== null) {
            const key = match[1];
            const value = match[2] ?? match[3] ?? match[4];
            params[key] = this._parseConditionValue(value);
        }
        
        return params;
    }

    /**
     * 处理条件块
     */
    _processConditionals(str, context, depth) {
        // 支持嵌套 if
        const ifPattern = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
        
        return str.replace(ifPattern, (match, condition, thenBlock, elseBlock = '') => {
            const result = this._evaluateCondition(condition.trim(), context);
            const block = result ? thenBlock : elseBlock;
            // 递归处理块内容
            return this.renderString(block, context, depth);
        });
    }

    /**
     * 处理循环
     */
    _processLoops(str, context, depth) {
        const eachPattern = /\{\{#each\s+([^\s]+)\s+as\s+([^\s}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
        
        return str.replace(eachPattern, (match, arrayPath, itemVar, body) => {
            const array = this.variableManager.get(arrayPath) || context[arrayPath] || [];
            if (!Array.isArray(array)) return '';
            
            return array.map((item, index) => {
                const itemContext = {
                    ...context,
                    [itemVar]: item,
                    [`${itemVar}Index`]: index,
                    [`${itemVar}First`]: index === 0,
                    [`${itemVar}Last`]: index === array.length - 1
                };
                return this.renderString(body, itemContext, depth);
            }).join('');
        });
    }
    
    /**
     * 处理 switch
     */
    _processSwitch(str, context, depth) {
        const switchPattern = /\{\{#switch\s+([^}]+)\}\}([\s\S]*?)\{\{\/switch\}\}/g;
        
        return str.replace(switchPattern, (match, path, body) => {
            const value = this.variableManager.get(path.trim()) ?? context[path.trim()];
            
            // 匹配 case
            const casePattern = /\{\{#case\s+([^}]+)\}\}([\s\S]*?)(?=\{\{#case|\{\{#default|\{\{\/switch\}\})/g;
            const defaultPattern = /\{\{#default\}\}([\s\S]*?)(?=\{\{\/switch\}\})/;
            
            let caseMatch;
            while ((caseMatch = casePattern.exec(body)) !== null) {
                const caseValue = this._parseConditionValue(caseMatch[1].trim());
                if (value === caseValue) {
                    return this.renderString(caseMatch[2], context, depth);
                }
            }
            
            // 默认分支
            const defaultMatch = body.match(defaultPattern);
            if (defaultMatch) {
                return this.renderString(defaultMatch[1], context, depth);
            }
            
            return '';
        });
    }
    
    /**
     * 处理变量插值
     */
    _processVariables(str, context) {
        // 支持过滤器 {{path | filter}}
        return str.replace(/\{\{([^#/>][^}]*)\}\}/g, (match, expr) => {
            expr = expr.trim();
            
            // 检查是否有过滤器
            const parts = expr.split('|').map(p => p.trim());
            const path = parts[0];
            const filters = parts.slice(1);
            
            // 获取值
            let value = context[path] !== undefined ? context[path] : this.variableManager.get(path);
            
            // 应用过滤器
            for (const filter of filters) {
                value = this._applyFilter(value, filter);
            }
            
            return value !== undefined ? String(value) : '';
        });
    }
    
    /**
     * 应用过滤器
     */
    _applyFilter(value, filter) {
        switch (filter) {
            case 'upper':
            case 'uppercase':
                return typeof value === 'string' ? value.toUpperCase() : value;
            case 'lower':
            case 'lowercase':
                return typeof value === 'string' ? value.toLowerCase() : value;
            case 'trim':
                return typeof value === 'string' ? value.trim() : value;
            case 'json':
                return JSON.stringify(value);
            case 'length':
                return Array.isArray(value) ? value.length : (typeof value === 'string' ? value.length : 0);
            case 'first':
                return Array.isArray(value) ? value[0] : value;
            case 'last':
                return Array.isArray(value) ? value[value.length - 1] : value;
            case 'reverse':
                return Array.isArray(value) ? [...value].reverse() : value;
            case 'sort':
                return Array.isArray(value) ? [...value].sort() : value;
            case 'default':
                return value ?? '';
            default:
                // 检查是否是 default(value) 格式
                if (filter.startsWith('default(') && filter.endsWith(')')) {
                    const defaultVal = this._parseConditionValue(filter.slice(8, -1));
                    return value ?? defaultVal;
                }
                return value;
        }
    }

    /**
     * 计算条件表达式
     */
    _evaluateCondition(condition, context) {
        // 否定
        if (condition.startsWith('!')) {
            return !this._evaluateCondition(condition.slice(1).trim(), context);
        }
        
        // 逻辑运算 && ||
        if (condition.includes('&&')) {
            const parts = condition.split('&&').map(p => p.trim());
            return parts.every(p => this._evaluateCondition(p, context));
        }
        if (condition.includes('||')) {
            const parts = condition.split('||').map(p => p.trim());
            return parts.some(p => this._evaluateCondition(p, context));
        }
        
        // 比较操作
        const compareMatch = condition.match(/^([^\s]+)\s*(==|!=|>|>=|<|<=)\s*(.+)$/);
        if (compareMatch) {
            const [, leftPath, op, rightStr] = compareMatch;
            const left = this.variableManager.get(leftPath.trim()) ?? context[leftPath.trim()];
            const right = this._parseConditionValue(rightStr.trim());
            
            switch (op) {
                case '==': return left == right;
                case '!=': return left != right;
                case '>': return left > right;
                case '>=': return left >= right;
                case '<': return left < right;
                case '<=': return left <= right;
            }
        }
        
        // 存在性检查
        if (condition.startsWith('exists(') && condition.endsWith(')')) {
            const path = condition.slice(7, -1).trim();
            return this.variableManager.get(path) !== undefined;
        }
        
        // 简单真值检查
        const value = this.variableManager.get(condition) ?? context[condition];
        return Boolean(value);
    }

    _parseConditionValue(str) {
        str = str.trim();
        if ((str.startsWith('"') && str.endsWith('"')) ||
            (str.startsWith("'") && str.endsWith("'"))) {
            return str.slice(1, -1);
        }
        const num = parseFloat(str);
        if (!isNaN(num)) return num;
        if (str === 'true') return true;
        if (str === 'false') return false;
        return str;
    }
}

// ==================== Lorebook 适配器 ====================

/**
 * Lorebook 适配器 - 将变量系统与 SillyTavern Lorebook 集成
 * 支持：
 * 1. 根据变量条件动态控制条目激活
 * 2. 在条目内容中使用变量插值
 * 3. 变量变化时自动更新相关条目
 */
class LorebookAdapter {
    constructor(variableManager, templateEngine) {
        this.vm = variableManager;
        this.templateEngine = templateEngine;
        this.conditionEvaluator = new ConditionEvaluator(variableManager);
        this.managedEntries = new Map(); // 管理的 Lorebook 条目
        this.entryConditions = new Map(); // 条目的激活条件
    }
    
    /**
     * 注册一个受管理的 Lorebook 条目
     * @param {object} entry - Lorebook 条目配置
     * @param {string} entry.id - 条目 ID
     * @param {string} entry.name - 条目名称
     * @param {string} entry.content - 条目内容（支持模板语法）
     * @param {object} entry.condition - 激活条件
     * @param {string[]} entry.keys - 触发关键词
     * @param {number} entry.priority - 优先级
     */
    registerEntry(entry) {
        const { id, condition, ...rest } = entry;
        this.managedEntries.set(id, { id, ...rest });
        if (condition) {
            this.entryConditions.set(id, condition);
        }
    }
    
    /**
     * 批量注册条目
     */
    registerEntries(entries) {
        for (const entry of entries) {
            this.registerEntry(entry);
        }
    }
    
    /**
     * 获取条目
     */
    getEntry(id) {
        return this.managedEntries.get(id);
    }
    
    /**
     * 删除条目
     */
    deleteEntry(id) {
        this.managedEntries.delete(id);
        this.entryConditions.delete(id);
    }
    
    /**
     * 检查条目是否应该激活
     * @param {string} entryId - 条目 ID
     * @returns {boolean}
     */
    isEntryActive(entryId) {
        const condition = this.entryConditions.get(entryId);
        if (!condition) return true; // 无条件则默认激活
        return this.conditionEvaluator.evaluate(condition);
    }
    
    /**
     * 渲染条目内容（应用变量插值）
     * @param {string} entryId - 条目 ID
     * @param {object} context - 额外上下文
     * @returns {string} 渲染后的内容
     */
    renderEntryContent(entryId, context = {}) {
        const entry = this.managedEntries.get(entryId);
        if (!entry) return '';
        return this.templateEngine.renderString(entry.content, context);
    }
    
    /**
     * 获取所有激活的条目
     * @returns {Array} 激活的条目列表
     */
    getActiveEntries() {
        const active = [];
        for (const [id, entry] of this.managedEntries) {
            if (this.isEntryActive(id)) {
                active.push({
                    ...entry,
                    renderedContent: this.renderEntryContent(id)
                });
            }
        }
        return active;
    }
    
    /**
     * 生成 SillyTavern Lorebook 格式的条目
     * @returns {Array} SillyTavern 格式的条目数组
     */
    exportToSillyTavern() {
        const entries = [];
        
        for (const [id, entry] of this.managedEntries) {
            if (!this.isEntryActive(id)) continue;
            
            entries.push({
                uid: id,
                key: entry.keys || [],
                keysecondary: entry.secondaryKeys || [],
                comment: entry.name || id,
                content: this.renderEntryContent(id),
                constant: entry.constant || false,
                order: entry.priority || 100,
                position: entry.position || 0, // 0 = before char, 1 = after char
                disable: false,
                selectiveLogic: 0,
                probability: 100,
            });
        }
        
        return entries;
    }
    
    /**
     * 从 SillyTavern Lorebook 导入条目
     * @param {Array} entries - SillyTavern 格式的条目
     * @param {object} options - 导入选项
     */
    importFromSillyTavern(entries, options = {}) {
        const { addConditions = false, prefix = '' } = options;
        
        for (const entry of entries) {
            this.registerEntry({
                id: prefix + (entry.uid || entry.comment),
                name: entry.comment,
                content: entry.content,
                keys: entry.key || [],
                secondaryKeys: entry.keysecondary || [],
                priority: entry.order || 100,
                position: entry.position || 0,
                constant: entry.constant || false,
            });
        }
    }
}

// ==================== AI 回复处理器 ====================

/**
 * AI 回复处理器 - 拦截和处理 AI 回复中的变量更新
 * 支持流式和非流式两种模式
 */
class ResponseProcessor {
    constructor(variableManager, updateParser) {
        this.vm = variableManager;
        this.parser = updateParser;
        this.buffer = ''; // 流式模式缓冲区
        this.mode = 'background'; // 'streaming' | 'background'
        this.onUpdate = null; // 更新回调
        
        // 标记模式
        this.markers = {
            start: '<UpdateVariable>',
            end: '</UpdateVariable>',
        };
    }
    
    /**
     * 设置处理模式
     * @param {'streaming' | 'background'} mode
     */
    setMode(mode) {
        this.mode = mode;
    }
    
    /**
     * 设置更新回调
     * @param {function} callback
     */
    setUpdateCallback(callback) {
        this.onUpdate = callback;
    }
    
    /**
     * 处理完整回复（非流式）
     * @param {string} response - AI 回复内容
     * @returns {{ cleanResponse: string, operations: Array, results: Array }}
     */
    processComplete(response) {
        // 解析操作
        const operations = this.parser.parse(response);
        
        // 执行操作
        const results = this.parser.executeAll(this.vm, operations);
        
        // 清理回复（移除更新标记）
        const cleanResponse = this._cleanResponse(response);
        
        // 触发回调
        if (this.onUpdate && operations.length > 0) {
            this.onUpdate({ operations, results });
        }
        
        return { cleanResponse, operations, results };
    }
    
    /**
     * 处理流式片段
     * @param {string} chunk - 流式片段
     * @returns {{ displayChunk: string, pendingOperations: Array }}
     */
    processChunk(chunk) {
        this.buffer += chunk;
        let displayChunk = chunk;
        const pendingOperations = [];
        
        // 检查是否有完整的更新块
        while (true) {
            const startIdx = this.buffer.indexOf(this.markers.start);
            if (startIdx === -1) break;
            
            const endIdx = this.buffer.indexOf(this.markers.end);
            if (endIdx === -1) {
                // 更新块未完成，隐藏开始标记之后的内容
                if (this.mode === 'streaming') {
                    displayChunk = this.buffer.slice(0, startIdx);
                }
                break;
            }
            
            // 提取完整的更新块
            const blockContent = this.buffer.slice(
                startIdx + this.markers.start.length,
                endIdx
            );
            
            // 解析并执行
            try {
                const ops = JSON.parse(blockContent.trim());
                const opsArray = Array.isArray(ops) ? ops : [ops];
                pendingOperations.push(...opsArray);
                
                // 立即执行（流式模式）
                if (this.mode === 'streaming') {
                    this.parser.executeAll(this.vm, opsArray);
                }
            } catch (e) {
                console.warn('[EDP] 流式解析失败:', e.message);
            }
            
            // 从缓冲区移除已处理的块
            this.buffer = this.buffer.slice(0, startIdx) +
                         this.buffer.slice(endIdx + this.markers.end.length);
        }
        
        return { displayChunk, pendingOperations };
    }
    
    /**
     * 流式结束时处理
     * @returns {{ operations: Array, results: Array }}
     */
    finishStream() {
        // 处理缓冲区中剩余的内容
        const operations = this.parser.parse(this.buffer);
        const results = this.mode === 'background' ?
            this.parser.executeAll(this.vm, operations) : [];
        
        // 清空缓冲区
        this.buffer = '';
        
        // 触发回调
        if (this.onUpdate && operations.length > 0) {
            this.onUpdate({ operations, results });
        }
        
        return { operations, results };
    }
    
    /**
     * 清理回复中的更新标记
     */
    _cleanResponse(response) {
        // 移除 <UpdateVariable>...</UpdateVariable> 块
        let clean = response.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '');
        
        // 移除 /data 命令行
        clean = clean.replace(/^\/data\s+\w+.*$/gm, '');
        
        // 移除 _.xxx() 调用
        clean = clean.replace(/_\.\w+\s*\([^)]*\)/g, '');
        
        // 清理多余空行
        clean = clean.replace(/\n{3,}/g, '\n\n');
        
        return clean.trim();
    }
}

// ==================== 提示词构建器 ====================

/**
 * 提示词构建器 - 构建动态提示词
 */
class PromptBuilder {
    constructor(variableManager, templateEngine, lorebookAdapter) {
        this.vm = variableManager;
        this.templateEngine = templateEngine;
        this.lorebookAdapter = lorebookAdapter;
    }
    
    /**
     * 构建系统提示词中的变量说明部分
     * @param {object} options - 构建选项
     * @returns {string} 变量说明文本
     */
    buildVariableInstructions(options = {}) {
        const {
            includeSchema = true,
            includeCurrentValues = true,
            includeSyntaxHelp = true,
            format = 'full' // 'full' | 'compact' | 'minimal'
        } = options;
        
        let instructions = '';
        
        if (format !== 'minimal') {
            instructions += '## 变量系统\n\n';
        }
        
        // 当前变量值
        if (includeCurrentValues) {
            instructions += '### 当前变量\n';
            instructions += '```json\n';
            instructions += JSON.stringify(this.vm.statData, null, 2);
            instructions += '\n```\n\n';
        }
        
        // 语法说明
        if (includeSyntaxHelp && format === 'full') {
            instructions += '### 变量更新语法\n';
            instructions += '使用以下格式更新变量：\n\n';
            instructions += '```\n';
            instructions += '/data set <路径> <值>      # 设置值\n';
            instructions += '/data add <路径> <增量>     # 数值增减\n';
            instructions += '/data push <路径> <值>     # 数组追加\n';
            instructions += '/data remove <路径>        # 删除\n';
            instructions += '```\n\n';
            instructions += '或使用 JSON 块：\n';
            instructions += '```\n';
            instructions += '<UpdateVariable>\n';
            instructions += '[{"op": "replace", "path": "路径", "value": 值}]\n';
            instructions += '</UpdateVariable>\n';
            instructions += '```\n\n';
        }
        
        return instructions;
    }
    
    /**
     * 构建包含变量的完整提示词
     * @param {string} basePrompt - 基础提示词
     * @param {object} options - 选项
     * @returns {string} 完整提示词
     */
    buildPrompt(basePrompt, options = {}) {
        let prompt = '';
        
        // 添加变量说明
        prompt += this.buildVariableInstructions(options);
        
        // 渲染基础提示词中的模板
        prompt += this.templateEngine.renderString(basePrompt, {});
        
        // 添加 Lorebook 条目
        if (options.includeLorebook !== false && this.lorebookAdapter) {
            const activeEntries = this.lorebookAdapter.getActiveEntries();
            if (activeEntries.length > 0) {
                prompt += '\n\n## 世界设定\n';
                for (const entry of activeEntries) {
                    prompt += `\n### ${entry.name}\n`;
                    prompt += entry.renderedContent + '\n';
                }
            }
        }
        
        return prompt;
    }
}

// ==================== 导入导出管理器 ====================

/**
 * 导入导出管理器 - 处理变量数据的导入导出
 */
class ImportExportManager {
    constructor(variableManager, templateEngine, lorebookAdapter) {
        this.vm = variableManager;
        this.templateEngine = templateEngine;
        this.lorebookAdapter = lorebookAdapter;
    }
    
    /**
     * 导出所有数据
     * @param {object} options - 导出选项
     * @returns {object} 导出的数据
     */
    exportAll(options = {}) {
        const {
            includeVariables = true,
            includeTemplates = true,
            includeLorebook = true,
            format = 'json' // 'json' | 'yaml'
        } = options;
        
        const data = {
            version: '1.0',
            exportedAt: new Date().toISOString(),
        };
        
        if (includeVariables) {
            data.variables = this.vm.export();
        }
        
        if (includeTemplates) {
            data.templates = this.templateEngine.getAllTemplates();
        }
        
        if (includeLorebook && this.lorebookAdapter) {
            data.lorebook = Array.from(this.lorebookAdapter.managedEntries.values());
        }
        
        return data;
    }
    
    /**
     * 导入数据
     * @param {object} data - 要导入的数据
     * @param {object} options - 导入选项
     */
    importAll(data, options = {}) {
        const {
            mergeVariables = false,
            clearExisting = false
        } = options;
        
        if (clearExisting) {
            this.vm.statData = {};
            this.vm.displayData = {};
            this.vm.deltaData = {};
        }
        
        if (data.variables) {
            if (mergeVariables) {
                Object.assign(this.vm.statData, data.variables.stat_data || {});
            } else {
                this.vm.import(data.variables);
            }
        }
        
        if (data.templates) {
            this.templateEngine.registerTemplates(data.templates);
        }
        
        if (data.lorebook && this.lorebookAdapter) {
            this.lorebookAdapter.registerEntries(data.lorebook);
        }
    }
    
    /**
     * 导出为 JSON 字符串
     */
    exportToJSON(options = {}) {
        const data = this.exportAll(options);
        return JSON.stringify(data, null, 2);
    }
    
    /**
     * 从 JSON 字符串导入
     */
    importFromJSON(jsonString, options = {}) {
        try {
            const data = JSON.parse(jsonString);
            this.importAll(data, options);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    
    /**
     * 下载导出文件
     */
    downloadExport(filename = 'edp-export.json', options = {}) {
        const json = this.exportToJSON(options);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        
        URL.revokeObjectURL(url);
    }
}

// ==================== 全局实例 ====================

const variableManager = new VariableManager();
const updateParser = new UpdateParser();
const templateEngine = new TemplateEngine(variableManager);
const lorebookAdapter = new LorebookAdapter(variableManager, templateEngine);
const responseProcessor = new ResponseProcessor(variableManager, updateParser);
const promptBuilder = new PromptBuilder(variableManager, templateEngine, lorebookAdapter);
const importExportManager = new ImportExportManager(variableManager, templateEngine, lorebookAdapter);

// ==================== UI 相关 ====================

/** 当前编辑的模板 */
let currentTemplateId = null;

/**
 * 加载设置
 */
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    // 更新 UI
    $("#edp_enabled").prop("checked", extension_settings[extensionName].enabled);
    $("#edp_auto_update").prop("checked", extension_settings[extensionName].autoUpdate);
    $("#edp_debug_mode").prop("checked", extension_settings[extensionName].debugMode);
    
    // 设置响应处理器模式
    responseProcessor.setMode(extension_settings[extensionName].updateMode || 'streaming');
}

/**
 * 设置变化处理
 */
function onSettingChange(settingKey) {
    return function(event) {
        const value = $(event.target).is(':checkbox') ?
            $(event.target).prop("checked") :
            $(event.target).val();
        extension_settings[extensionName][settingKey] = value;
        saveSettingsDebounced();
        
        // 特殊处理
        if (settingKey === 'updateMode') {
            responseProcessor.setMode(value);
        }
    };
}

/**
 * 打开主面板
 */
function openMainPanel() {
    // 创建遮罩层
    let overlay = document.getElementById('edp_overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'edp_overlay';
        overlay.className = 'edp-overlay';
        overlay.addEventListener('click', closeMainPanel);
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    
    // 显示主面板
    const panel = document.getElementById('edp_main_panel');
    if (panel) {
        panel.style.display = 'flex';
        // 阻止面板内部点击事件冒泡到遮罩层
        panel.onclick = function(e) {
            e.stopPropagation();
        };
        refreshVariableTree();
        refreshTemplateList();
    }
}

/**
 * 关闭主面板
 */
function closeMainPanel() {
    const panel = document.getElementById('edp_main_panel');
    if (panel) {
        panel.style.display = 'none';
    }
    
    const overlay = document.getElementById('edp_overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

/**
 * 刷新变量树显示
 */
function refreshVariableTree() {
    const container = document.getElementById('edp_variable_tree');
    if (!container) return;
    
    const data = variableManager.export();
    const html = renderVariableTree(data.stat_data, '');
    container.innerHTML = html || '<div class="edp-empty">暂无变量数据</div>';
}

/**
 * 渲染变量树
 */
function renderVariableTree(obj, path, depth = 0) {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') {
        const escapedValue = escapeHtml(JSON.stringify(obj));
        return `<div class="edp-var-item" style="padding-left: ${depth * 16}px" data-path="${path}">
            <span class="edp-var-key">${escapeHtml(path.split('.').pop())}</span>:
            <span class="edp-var-value">${escapedValue}</span>
            <span class="edp-var-actions">
                <button class="edp-btn-tiny" onclick="EDP_UI.editVariable('${path}')" title="编辑">✏️</button>
            </span>
        </div>`;
    }
    
    let html = '';
    const entries = Object.entries(obj).filter(([key]) => key !== '$meta');
    
    if (entries.length === 0) {
        return '<div class="edp-empty">空对象</div>';
    }
    
    for (const [key, value] of entries) {
        const newPath = path ? `${path}.${key}` : key;
        const escapedKey = escapeHtml(key);
        
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            html += `<div class="edp-var-group" style="padding-left: ${depth * 16}px">
                <span class="edp-var-key edp-collapsible" onclick="EDP_UI.toggleGroup(this)">📁 ${escapedKey}</span>
                <span class="edp-var-actions">
                    <button class="edp-btn-tiny" onclick="EDP_UI.addVariable('${newPath}')" title="添加子项">+</button>
                </span>
            </div>`;
            html += `<div class="edp-var-children">`;
            html += renderVariableTree(value, newPath, depth + 1);
            html += `</div>`;
        } else if (Array.isArray(value)) {
            html += `<div class="edp-var-group" style="padding-left: ${depth * 16}px">
                <span class="edp-var-key edp-collapsible" onclick="EDP_UI.toggleGroup(this)">📋 ${escapedKey} [${value.length}]</span>
                <span class="edp-var-actions">
                    <button class="edp-btn-tiny" onclick="EDP_UI.pushToArray('${newPath}')" title="追加元素">+</button>
                </span>
            </div>`;
            html += `<div class="edp-var-children">`;
            value.forEach((item, index) => {
                const itemPath = `${newPath}.${index}`;
                if (typeof item === 'object' && item !== null) {
                    html += renderVariableTree(item, itemPath, depth + 1);
                } else {
                    html += `<div class="edp-var-item" style="padding-left: ${(depth + 1) * 16}px" data-path="${itemPath}">
                        <span class="edp-var-key">[${index}]</span>:
                        <span class="edp-var-value">${escapeHtml(JSON.stringify(item))}</span>
                        <span class="edp-var-actions">
                            <button class="edp-btn-tiny" onclick="EDP_UI.editVariable('${itemPath}')" title="编辑">✏️</button>
                            <button class="edp-btn-tiny" onclick="EDP_UI.removeVariable('${itemPath}')" title="删除">🗑️</button>
                        </span>
                    </div>`;
                }
            });
            html += `</div>`;
        } else {
            const escapedValue = escapeHtml(JSON.stringify(value));
            html += `<div class="edp-var-item" style="padding-left: ${depth * 16}px" data-path="${newPath}">
                <span class="edp-var-key">${escapedKey}</span>:
                <span class="edp-var-value">${escapedValue}</span>
                <span class="edp-var-actions">
                    <button class="edp-btn-tiny" onclick="EDP_UI.editVariable('${newPath}')" title="编辑">✏️</button>
                    <button class="edp-btn-tiny" onclick="EDP_UI.removeVariable('${newPath}')" title="删除">🗑️</button>
                </span>
            </div>`;
        }
    }
    return html;
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
    if (typeof str !== 'string') str = String(str);
    return str.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

/**
 * 刷新模板列表
 */
function refreshTemplateList() {
    const container = document.getElementById('edp_template_list');
    if (!container) return;
    
    const templates = templateEngine.getAllTemplates();
    const systemTemplates = templates.filter(t => t.category === 'system');
    const userTemplates = templates.filter(t => t.category !== 'system');
    
    let html = '';
    
    // 系统模板
    html += `<div class="edp-tree-group">
        <div class="edp-tree-header" onclick="EDP_UI.toggleGroup(this)">▶ 系统模板</div>
        <div class="edp-tree-items">`;
    if (systemTemplates.length > 0) {
        systemTemplates.forEach(t => {
            html += `<div class="edp-tree-item ${currentTemplateId === t.id ? 'active' : ''}"
                         onclick="EDP_UI.selectTemplate('${t.id}')">${escapeHtml(t.name || t.id)}</div>`;
        });
    } else {
        html += `<div class="edp-tree-item edp-empty">暂无模板</div>`;
    }
    html += `</div></div>`;
    
    // 用户模板
    html += `<div class="edp-tree-group">
        <div class="edp-tree-header" onclick="EDP_UI.toggleGroup(this)">▶ 用户模板</div>
        <div class="edp-tree-items">`;
    if (userTemplates.length > 0) {
        userTemplates.forEach(t => {
            html += `<div class="edp-tree-item ${currentTemplateId === t.id ? 'active' : ''}"
                         onclick="EDP_UI.selectTemplate('${t.id}')">${escapeHtml(t.name || t.id)}</div>`;
        });
    } else {
        html += `<div class="edp-tree-item edp-empty">暂无模板</div>`;
    }
    html += `</div></div>`;
    
    container.innerHTML = html;
}

/**
 * 选择模板
 */
function selectTemplate(templateId) {
    currentTemplateId = templateId;
    const template = templateEngine.getTemplate(templateId);
    
    if (template) {
        // 填充编辑器
        $('#edp_code_editor').val(template.content || '');
        $('#edp_template_name').val(template.name || templateId);
        $('#edp_template_category').val(template.category || 'user');
        $('#edp_template_desc').val(template.description || '');
        
        // 更新预览
        updatePreview();
    }
    
    refreshTemplateList();
}

/**
 * 创建新模板
 */
function createNewTemplate() {
    const id = `template_${Date.now()}`;
    templateEngine.registerTemplate(id, {
        id,
        name: '新模板',
        content: '<!-- 在此编写模板内容 -->\n{{变量路径}}',
        category: 'user',
        description: ''
    });
    selectTemplate(id);
}

/**
 * 保存当前模板
 */
function saveCurrentTemplate() {
    if (!currentTemplateId) {
        alert('请先选择或创建一个模板');
        return;
    }
    
    const template = {
        id: currentTemplateId,
        name: $('#edp_template_name').val() || currentTemplateId,
        content: $('#edp_code_editor').val(),
        category: $('#edp_template_category').val(),
        description: $('#edp_template_desc').val()
    };
    
    templateEngine.registerTemplate(currentTemplateId, template);
    refreshTemplateList();
    console.log('[EDP] 模板已保存:', currentTemplateId);
}

/**
 * 更新预览
 */
function updatePreview() {
    const previewContainer = document.getElementById('edp_preview_output');
    if (!previewContainer) return;
    
    const content = $('#edp_code_editor').val();
    if (!content) {
        previewContainer.innerHTML = '<p class="edp-placeholder">预览结果将显示在这里</p>';
        return;
    }
    
    try {
        const rendered = templateEngine.renderString(content, {});
        previewContainer.textContent = rendered;
    } catch (e) {
        previewContainer.innerHTML = `<span class="edp-error">渲染错误: ${escapeHtml(e.message)}</span>`;
    }
}

/**
 * 切换标签页
 */
function switchTab(tabName) {
    // 更新标签按钮
    document.querySelectorAll('.edp-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // 更新内容
    document.querySelectorAll('.edp-tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `edp_tab_${tabName}`);
    });
}

/**
 * 导入数据
 */
function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const result = importExportManager.importFromJSON(text);
            if (result.success) {
                refreshVariableTree();
                refreshTemplateList();
                alert('导入成功！');
            } else {
                alert(`导入失败: ${result.error}`);
            }
        } catch (err) {
            alert(`导入失败: ${err.message}`);
        }
    };
    input.click();
}

/**
 * 导出数据
 */
function exportData() {
    importExportManager.downloadExport('edp-export.json');
}

// UI 操作对象（暴露给 onclick）
const EDP_UI = {
    toggleGroup(element) {
        const parent = element.closest('.edp-var-group, .edp-tree-group');
        if (parent) {
            const children = parent.querySelector('.edp-var-children, .edp-tree-items');
            if (children) {
                children.style.display = children.style.display === 'none' ? '' : 'none';
                // 更新箭头
                if (element.textContent.startsWith('▶')) {
                    element.textContent = element.textContent.replace('▶', '▼');
                } else if (element.textContent.startsWith('▼')) {
                    element.textContent = element.textContent.replace('▼', '▶');
                }
            }
        }
    },
    
    editVariable(path) {
        const currentValue = variableManager.get(path);
        const newValue = prompt(`编辑变量 ${path}:`, JSON.stringify(currentValue));
        if (newValue !== null) {
            try {
                const parsed = JSON.parse(newValue);
                variableManager.set(path, parsed);
                refreshVariableTree();
            } catch {
                // 如果不是有效 JSON，当作字符串
                variableManager.set(path, newValue);
                refreshVariableTree();
            }
        }
    },
    
    addVariable(parentPath) {
        const key = prompt('输入新变量名:');
        if (key) {
            const value = prompt('输入变量值 (JSON 格式):');
            if (value !== null) {
                try {
                    const parsed = JSON.parse(value);
                    variableManager.set(`${parentPath}.${key}`, parsed);
                } catch {
                    variableManager.set(`${parentPath}.${key}`, value);
                }
                refreshVariableTree();
            }
        }
    },
    
    pushToArray(path) {
        const value = prompt('输入要追加的值 (JSON 格式):');
        if (value !== null) {
            try {
                const parsed = JSON.parse(value);
                variableManager.push(path, parsed);
            } catch {
                variableManager.push(path, value);
            }
            refreshVariableTree();
        }
    },
    
    removeVariable(path) {
        if (confirm(`确定删除 ${path}?`)) {
            variableManager.remove(path);
            refreshVariableTree();
        }
    },
    
    selectTemplate,
    createNewTemplate,
    saveCurrentTemplate,
    switchTab,
};

// 暴露给全局
window.EDP_UI = EDP_UI;

// ==================== 扩展入口 ====================

jQuery(async () => {
    console.log('[EDP] EasyDynamicPrompts 扩展加载中...');
    
    // 加载设置面板 HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);
    
    // 绑定设置事件
    $("#edp_enabled").on("input", onSettingChange("enabled"));
    $("#edp_auto_update").on("input", onSettingChange("autoUpdate"));
    $("#edp_debug_mode").on("input", onSettingChange("debugMode"));
    
    // 绑定按钮事件
    $("#edp_open_panel").on("click", openMainPanel);
    $("#edp_panel_close").on("click", closeMainPanel);
    
    // 模板编辑器事件
    $("#edp_new_template").on("click", createNewTemplate);
    $("#edp_save").on("click", saveCurrentTemplate);
    $("#edp_refresh_vars").on("click", refreshVariableTree);
    
    // 导入导出
    $("#edp_import").on("click", importData);
    $("#edp_export").on("click", exportData);
    
    // 标签页切换
    $(document).on("click", ".edp-tab", function() {
        switchTab($(this).data("tab"));
    });
    
    // 代码编辑器自动预览
    $("#edp_code_editor").on("input", function() {
        if ($("#edp_auto_preview").prop("checked")) {
            updatePreview();
        }
    });
    $("#edp_manual_preview").on("click", updatePreview);
    
    // 应用按钮 - 保存并更新预览
    $("#edp_apply").on("click", function() {
        saveCurrentTemplate();
        updatePreview();
    });
    
    // 加载设置
    await loadSettings();
    
    // 监听变量变化事件
    document.addEventListener('edp_variable_changed', (e) => {
        const { path, oldValue, newValue, reason } = e.detail;
        if (extension_settings[extensionName]?.debugMode) {
            console.log(`[EDP] 变量变化: ${path} = ${oldValue} → ${newValue}` + (reason ? ` (${reason})` : ''));
        }
        refreshVariableTree();
    });
    
    // 设置更新回调
    responseProcessor.setUpdateCallback(({ operations, results }) => {
        if (extension_settings[extensionName]?.debugMode) {
            console.log('[EDP] 变量更新完成:', operations.length, '个操作');
        }
    });
    
    console.log('[EDP] EasyDynamicPrompts 扩展加载完成');
});

// 导出给其他模块使用
window.EasyDynamicPrompts = {
    // 全局实例
    variableManager,
    updateParser,
    templateEngine,
    lorebookAdapter,
    responseProcessor,
    promptBuilder,
    importExportManager,
    
    // 核心类
    VariableManager,
    UpdateParser,
    TemplateEngine,
    
    // 新增核心类（Minecraft + JSON Patch 风格）
    PathParser,
    ConditionEvaluator,
    CalcEngine,
    OperationExecutor,
    BatchExecutor,
    SchemaValidator,
    
    // 适配器和处理器类
    LorebookAdapter,
    ResponseProcessor,
    PromptBuilder,
    ImportExportManager,
    
    // 工具函数
    deepClone,
};