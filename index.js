/**
 * EasyDynamicPrompts - 动态提示词构建器
 * SillyTavern 扩展入口
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

// ==================== 核心类 ====================

/**
 * 变量管理器 - 管理动态变量的CRUD操作
 */
class VariableManager {
    constructor() {
        this.statData = {};      // 实际变量数据
        this.displayData = {};   // 显示数据（变化历史）
        this.deltaData = {};     // 增量数据（本轮变化）
        this.schema = null;      // 模式校验器
    }

    /**
     * 获取变量值
     * @param {string} path - 变量路径，如 "角色.络络.好感度"
     * @param {object} options - 可选配置
     * @returns {any} 变量值
     */
    get(path, options = {}) {
        const { defaultValue = undefined, source = 'stat' } = options;
        const dataSource = source === 'display' ? this.displayData : 
                          source === 'delta' ? this.deltaData : this.statData;
        
        const value = this._getByPath(dataSource, path);
        
        // 处理 [值, 描述] 格式
        if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') {
            return value[0];
        }
        
        return value !== undefined ? value : defaultValue;
    }

    /**
     * 设置变量值
     * @param {string} path - 变量路径
     * @param {any} value - 新值
     * @param {object} options - 可选配置
     * @returns {boolean} 是否成功
     */
    set(path, value, options = {}) {
        const { reason = '', validateOldValue = undefined } = options;
        
        // 获取旧值
        const oldValue = this.get(path);
        
        // 如果需要校验旧值
        if (validateOldValue !== undefined && oldValue !== validateOldValue) {
            console.warn(`[EDP] 变量更新失败：旧值校验不匹配 (期望: ${validateOldValue}, 实际: ${oldValue})`);
            return false;
        }
        
        // 设置新值
        this._setByPath(this.statData, path, value);
        
        // 更新 displayData
        const displayValue = reason ? 
            `${oldValue} → ${value} (${reason})` : 
            `${oldValue} → ${value}`;
        this._setByPath(this.displayData, path, displayValue);
        
        // 更新 deltaData
        this._setByPath(this.deltaData, path, displayValue);
        
        // 触发变量变化事件
        this._emitChange(path, oldValue, value, reason);
        
        return true;
    }

    /**
     * 数值增量更新
     * @param {string} path - 变量路径
     * @param {number} delta - 增量值
     * @param {string} reason - 原因
     */
    increment(path, delta, reason = '') {
        const oldValue = this.get(path) || 0;
        if (typeof oldValue !== 'number') {
            console.warn(`[EDP] increment 操作失败：${path} 不是数值类型`);
            return false;
        }
        return this.set(path, oldValue + delta, { reason });
    }

    /**
     * 向数组/对象添加元素
     */
    assign(path, keyOrValue, value = undefined) {
        const target = this._getByPath(this.statData, path);
        
        if (Array.isArray(target)) {
            if (value === undefined) {
                // 尾部追加
                target.push(keyOrValue);
            } else {
                // 指定位置插入
                target.splice(keyOrValue, 0, value);
            }
        } else if (typeof target === 'object' && target !== null) {
            // 对象添加键值对
            target[keyOrValue] = value;
        } else {
            console.warn(`[EDP] assign 操作失败：${path} 不是数组或对象`);
            return false;
        }
        
        return true;
    }

    /**
     * 删除变量或元素
     */
    remove(path, keyOrIndex = undefined) {
        if (keyOrIndex === undefined) {
            // 删除整个变量
            return this._deleteByPath(this.statData, path);
        }
        
        const target = this._getByPath(this.statData, path);
        
        if (Array.isArray(target)) {
            if (typeof keyOrIndex === 'number') {
                target.splice(keyOrIndex, 1);
            } else {
                const index = target.indexOf(keyOrIndex);
                if (index > -1) target.splice(index, 1);
            }
        } else if (typeof target === 'object' && target !== null) {
            delete target[keyOrIndex];
        }
        
        return true;
    }

    /**
     * 清空增量数据
     */
    clearDelta() {
        this.deltaData = {};
    }

    /**
     * 导出数据
     */
    export() {
        return {
            stat_data: JSON.parse(JSON.stringify(this.statData)),
            display_data: JSON.parse(JSON.stringify(this.displayData)),
            delta_data: JSON.parse(JSON.stringify(this.deltaData)),
        };
    }

    /**
     * 导入数据
     */
    import(data) {
        if (data.stat_data) this.statData = data.stat_data;
        if (data.display_data) this.displayData = data.display_data;
        if (data.delta_data) this.deltaData = data.delta_data;
    }

    // ========== 私有方法 ==========

    _getByPath(obj, path) {
        if (!path) return obj;
        const keys = this._parsePath(path);
        let current = obj;
        for (const key of keys) {
            if (current === undefined || current === null) return undefined;
            current = current[key];
        }
        return current;
    }

    _setByPath(obj, path, value) {
        const keys = this._parsePath(path);
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (current[key] === undefined) {
                current[key] = typeof keys[i + 1] === 'number' ? [] : {};
            }
            current = current[key];
        }
        current[keys[keys.length - 1]] = value;
    }

    _deleteByPath(obj, path) {
        const keys = this._parsePath(path);
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (current[key] === undefined) return false;
            current = current[key];
        }
        delete current[keys[keys.length - 1]];
        return true;
    }

    _parsePath(path) {
        // 解析路径，支持 "a.b.c" 和 "a[0].b" 格式
        return path.replace(/\[(\d+)\]/g, '.$1').split('.').map(key => {
            const num = parseInt(key);
            return isNaN(num) ? key : num;
        });
    }

    _emitChange(path, oldValue, newValue, reason) {
        // 触发自定义事件
        const event = new CustomEvent('edp_variable_changed', {
            detail: { path, oldValue, newValue, reason }
        });
        document.dispatchEvent(event);
    }
}

/**
 * 更新语句解析器 - 解析 AI 回复中的变量更新命令
 */
class UpdateParser {
    constructor() {
        // 匹配 _.set, _.add, _.assign, _.remove 命令
        this.patterns = {
            set: /\_\.set\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^,)]+)\s*)?(?:,\s*([^)]+))?\s*\)/g,
            add: /\_\.add\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\s*\)/g,
            assign: /\_\.assign\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^,)]+)\s*)?(?:,\s*([^)]+))?\s*\)/g,
            remove: /\_\.remove\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\s*\)/g,
        };
    }

    /**
     * 从文本中解析更新命令
     * @param {string} text - 包含更新命令的文本
     * @returns {Array} 解析出的命令列表
     */
    parse(text) {
        const commands = [];
        
        // 解析 _.set 命令
        let match;
        const setPattern = new RegExp(this.patterns.set.source, 'g');
        while ((match = setPattern.exec(text)) !== null) {
            commands.push({
                type: 'set',
                fullMatch: match[0],
                path: match[1],
                args: [match[2], match[3]].filter(Boolean).map(this._parseValue),
            });
        }
        
        // 解析 _.add 命令
        const addPattern = new RegExp(this.patterns.add.source, 'g');
        while ((match = addPattern.exec(text)) !== null) {
            commands.push({
                type: 'add',
                fullMatch: match[0],
                path: match[1],
                args: [this._parseValue(match[2])],
            });
        }
        
        // 解析 _.assign 命令
        const assignPattern = new RegExp(this.patterns.assign.source, 'g');
        while ((match = assignPattern.exec(text)) !== null) {
            commands.push({
                type: 'assign',
                fullMatch: match[0],
                path: match[1],
                args: [match[2], match[3]].filter(Boolean).map(this._parseValue),
            });
        }
        
        // 解析 _.remove 命令
        const removePattern = new RegExp(this.patterns.remove.source, 'g');
        while ((match = removePattern.exec(text)) !== null) {
            commands.push({
                type: 'remove',
                fullMatch: match[0],
                path: match[1],
                args: match[2] ? [this._parseValue(match[2])] : [],
            });
        }
        
        return commands;
    }

    /**
     * 解析值（字符串/数字/布尔/对象）
     */
    _parseValue(str) {
        if (!str) return undefined;
        str = str.trim();
        
        // 尝试解析为 JSON
        try {
            return JSON.parse(str);
        } catch {
            // 如果是带引号的字符串
            if ((str.startsWith("'") && str.endsWith("'")) || 
                (str.startsWith('"') && str.endsWith('"'))) {
                return str.slice(1, -1);
            }
            // 尝试解析为数字
            const num = parseFloat(str);
            if (!isNaN(num)) return num;
            // 返回原始字符串
            return str;
        }
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
    variableManager,
    updateParser,
    templateEngine,
    VariableManager,
    UpdateParser,
    TemplateEngine,
};