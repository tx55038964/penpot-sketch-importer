# Penpot Sketch 导入插件

把 `.sketch` 文件（Sketch 43 及以后版本保存的）导入到 Penpot 当前页面。

## 安装

打开 Penpot 的设计文件，按 `Ctrl/Cmd + Alt + P` 打开插件管理器，填入下面的地址并安装：

```
https://tx55038964.github.io/penpot-sketch-importer/manifest.json
```

## 使用

打开插件 → 选择 .sketch 文件 → 勾选要导入的页面 → 开始导入。
.sketch 文件只在浏览器里解析，不会上传到任何服务器。

## 本地开发

`node serve.mjs` 在 `http://localhost:4400` 提供文件。本地调试时把 `manifest.json` 的 `host`
临时改成 `http://localhost:4400/`，再在 Penpot 里安装 `http://localhost:4400/manifest.json`。

## 支持情况

| Sketch | Penpot | 说明 |
|---|---|---|
| 画板 Artboard | Board | 背景色、裁切 |
| 编组 | Group | |
| 矩形 / 椭圆 | Rectangle / Ellipse | 圆角（含四角不同） |
| 路径 / 星形 / 三角形 / 多边形 | Path | 贝塞尔曲线 |
| 形状组合（布尔运算） | Boolean | 合并 / 减去 / 相交 / 差集 |
| 文字 | Text | 多段样式、字号、颜色、行高、字间距、对齐 |
| 位图 | 图片填充的矩形 | |
| 蒙版 | Mask Group | |
| Symbol 实例 | Board（已分离） | 支持文字 / 图片 / 嵌套 Symbol / 图层样式的覆盖 |
| 填充 / 描边 / 阴影 / 内阴影 / 模糊 / 透明度 / 混合模式 | 同名属性 | 角度渐变按线性渐变处理 |

## 已知限制

- **字体**：Penpot 默认没有 PingFang SC、MiSans、阿里巴巴普惠体等字体。请先在 Penpot 的
  「字体」页面上传这些字体，再导入；找不到的字体会用 Noto Sans SC 等替代，并在结果里列出来。
- Symbol 实例导入后是普通图层，不会和组件保持关联（可以勾选"把 Symbol 母版转成 Penpot 组件"）。
- 路径上的单点圆角、背景模糊、箭头端点、Sketch 的智能布局和约束（Resizing）暂不支持。
- 旋转的图片会按未旋转的位置放置。

## 离线测试

`test/mock-render.mjs` 用模拟的 penpot 对象运行插件，并把结果渲染成 SVG，便于和 Sketch 预览图对比：
```bash
unzip 门店.sketch -d /tmp/sk
node test/mock-render.mjs /tmp/sk /tmp/render.html
```
