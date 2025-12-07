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
    }
    
    /**
     * 初始化执行器（延迟初始化避免循环依赖）
     */
    _initExecutors() {
        if (!this.executor) {
            this.executor = new OperationExecutor(this);
            this.batchExecutor = new BatchExecutor(this);
        }
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
    }

    /**
     * 注册模板
     */
    registerTemplate(id, template) {
        this.templates.set(id, template);
        this.cache.delete(id); // 清除缓存
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
        return this.renderString(template.content, context);
    }

    /**
     * 渲染模板字符串
     */
    renderString(templateStr, context = {}) {
        let result = templateStr;
        
        // 1. 处理变量插值 {{path}}
        result = result.replace(/\{\{([^#/>][^}]*)\}\}/g, (match, path) => {
            path = path.trim();
            // 先从 context 查找，再从变量管理器查找
            if (context[path] !== undefined) {
                return String(context[path]);
            }
            const value = this.variableManager.get(path);
            return value !== undefined ? String(value) : '';
        });
        
        // 2. 处理条件块 {{#if condition}}...{{else}}...{{/if}}
        result = this._processConditionals(result, context);
        
        // 3. 处理循环 {{#each array as item}}...{{/each}}
        result = this._processLoops(result, context);
        
        return result;
    }

    /**
     * 处理条件块
     */
    _processConditionals(str, context) {
        const ifPattern = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
        
        return str.replace(ifPattern, (match, condition, thenBlock, elseBlock = '') => {
            const result = this._evaluateCondition(condition.trim(), context);
            return result ? thenBlock : elseBlock;
        });
    }

    /**
     * 处理循环
     */
    _processLoops(str, context) {
        const eachPattern = /\{\{#each\s+([^\s]+)\s+as\s+([^\s}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
        
        return str.replace(eachPattern, (match, arrayPath, itemVar, body) => {
            const array = this.variableManager.get(arrayPath) || context[arrayPath] || [];
            if (!Array.isArray(array)) return '';
            
            return array.map((item, index) => {
                const itemContext = { ...context, [itemVar]: item, [`${itemVar}Index`]: index };
                return this.renderString(body, itemContext);
            }).join('');
        });
    }

    /**
     * 计算条件表达式
     */
    _evaluateCondition(condition, context) {
        // 简单的条件解析
        // 支持: path, path > 10, path == "value", !path
        
        // 否定
        if (condition.startsWith('!')) {
            return !this._evaluateCondition(condition.slice(1).trim(), context);
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

// ==================== 全局实例 ====================

const variableManager = new VariableManager();
const updateParser = new UpdateParser();
const templateEngine = new TemplateEngine(variableManager);

// ==================== UI 相关 ====================

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
    };
}

/**
 * 打开主面板
 */
function openMainPanel() {
    // 显示主面板弹窗
    const panel = document.getElementById('edp_main_panel');
    if (panel) {
        panel.style.display = 'block';
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
}

/**
 * 刷新变量树显示
 */
function refreshVariableTree() {
    const container = document.getElementById('edp_variable_tree');
    if (!container) return;
    
    const data = variableManager.export();
    container.innerHTML = renderVariableTree(data.stat_data, '');
}

/**
 * 渲染变量树
 */
function renderVariableTree(obj, path, depth = 0) {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') {
        return `<div class="edp-var-item" style="padding-left: ${depth * 16}px">
            <span class="edp-var-path">${path}</span>: 
            <span class="edp-var-value">${JSON.stringify(obj)}</span>
        </div>`;
    }
    
    let html = '';
    for (const [key, value] of Object.entries(obj)) {
        if (key === '$meta') continue; // 跳过元数据
        
        const newPath = path ? `${path}.${key}` : key;
        
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            html += `<div class="edp-var-group" style="padding-left: ${depth * 16}px">
                <span class="edp-var-key">📁 ${key}</span>
            </div>`;
            html += renderVariableTree(value, newPath, depth + 1);
        } else {
            html += `<div class="edp-var-item" style="padding-left: ${depth * 16}px">
                <span class="edp-var-key">${key}</span>: 
                <span class="edp-var-value">${JSON.stringify(value)}</span>
            </div>`;
        }
    }
    return html;
}

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
    
    // 加载设置
    await loadSettings();
    
    // 监听变量变化事件
    document.addEventListener('edp_variable_changed', (e) => {
        const { path, oldValue, newValue, reason } = e.detail;
        console.log(`[EDP] 变量变化: ${path} = ${oldValue} → ${newValue}` + (reason ? ` (${reason})` : ''));
        refreshVariableTree();
    });
    
    console.log('[EDP] EasyDynamicPrompts 扩展加载完成');
});

// 导出给其他模块使用
window.EasyDynamicPrompts = {
    // 全局实例
    variableManager,
    updateParser,
    templateEngine,
    
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
    
    // 工具函数
    deepClone,
};