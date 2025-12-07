# EasyDynamicPrompts

动态提示词构建器 - SillyTavern 扩展

## 功能特性

- 🎯 **变量管理** - 创建、编辑、删除变量，支持类型校验和模式保护
- 🔀 **条件逻辑** - 支持 if/else、循环等控制流
- 📝 **模板系统** - Handlebars 风格模板语法
- 🔄 **自动更新** - 解析 AI 回复中的变量更新命令
- 📦 **导入导出** - 支持 JSON 格式配置

## 安装

将本扩展文件夹放入 SillyTavern 的扩展目录：

```
SillyTavern/public/scripts/extensions/third-party/EasyDynamicPrompts/
```

## 使用

1. 在 SillyTavern 中启用扩展
2. 点击设置面板中的"打开编辑器"
3. 创建或编辑模板
4. 保存并应用

## 变量更新语法

支持以下更新命令：

```javascript
_.set('路径', 值)           // 设置变量
_.add('路径', 增量)         // 数值增减
_.assign('路径', 值)        // 数组/对象添加
_.remove('路径')            // 删除变量
```

## 模板语法

```handlebars
{{变量路径}}                         <!-- 变量插值 -->
{{#if 条件}}内容{{else}}备选{{/if}}  <!-- 条件 -->
{{#each 数组 as item}}{{item}}{{/each}}  <!-- 循环 -->
```

## 许可

MIT License