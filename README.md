# EasyDynamicPrompts

<p align="center">
  <strong>动态提示词构建器 - SillyTavern 扩展</strong>
</p>

<p align="center">
  为 SillyTavern 设计的强大动态提示词构建工具，提供变量管理、条件逻辑、模板系统和自动适配功能。
</p>

---

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| 🎯 **变量管理** | 创建、编辑、删除变量，支持嵌套路径和类型校验 |
| 🔀 **条件逻辑** | 支持 if/else、循环等控制流 |
| 📝 **模板系统** | Handlebars 风格模板语法，支持嵌套模板 |
| 🔄 **自动更新** | 解析 AI 回复中的变量更新命令 |
| 📊 **变化追踪** | 记录变量变化历史，支持 display_data 和 delta_data |
| 📦 **导入导出** | 支持 JSON 格式配置导入导出 |

## 📥 安装

将本扩展文件夹放入 SillyTavern 的第三方扩展目录：

```
SillyTavern/public/scripts/extensions/third-party/EasyDynamicPrompts/
```

或通过 Git 克隆：

```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/LucNocturne/EasyDynamicPrompts.git
```

## 🚀 使用方法

1. 在 SillyTavern 中启用扩展
2. 在设置面板找到 **EasyDynamicPrompts** 部分
3. 点击 **"打开编辑器"** 按钮
4. 创建或编辑模板
5. 保存并应用

## 📖 变量更新语法

AI 可以在回复中使用以下命令更新变量：

```javascript
// 设置变量
_.set('角色.络络.好感度', 50)

// 设置变量（带旧值校验）
_.set('角色.络络.好感度', 50, 55)

// 数值增减
_.add('角色.络络.好感度', 5)
_.add('角色.络络.好感度', -3)

// 向数组添加元素
_.assign('背包', '新物品')

// 向对象添加键值对
_.assign('技能', '火球术', { 等级: 1 })

// 删除变量
_.remove('临时标记')

// 从数组删除元素
_.remove('背包', '消耗品')
```

## 📝 模板语法

```handlebars
<!-- 变量插值 -->
{{角色.络络.好感度}}

<!-- 条件判断 -->
{{#if 角色.络络.好感度 > 50}}
络络对你很有好感
{{else}}
络络对你态度一般
{{/if}}

<!-- 循环遍历 -->
{{#each 背包 as item}}
- {{item}}
{{/each}}

<!-- 存在性检查 -->
{{#if exists(角色.络络)}}
络络在场
{{/if}}
```

## 🗂️ 数据结构

支持 `[值, 描述]` 格式的变量：

```json
{
  "角色": {
    "络络": {
      "好感度": [50, "对玩家的好感程度，范围 0-100"],
      "状态": ["正常", "当前状态"]
    }
  }
}
```

## ⚠️ 许可证

本项目使用**自定义许可证**，包含特定社区限制条款。

详见 [LICENSE](LICENSE) 文件。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📞 联系

如有问题或建议，请在 GitHub 上提交 Issue。