# 应用图标

唯一发布源为 `web/icons/lingua.svg`，原样来自
`design/icon-candidates/voice-white-v1/lingua-icon.svg`。`design/` 不随仓库发布，
所以重建使用已纳入源码的 SVG；不要手工修改生成图片。

仅更新图标时需要安装绘图依赖，日常网页、Docker 和原生构建直接使用已提交的资源：

```sh
python -m pip install -r mobile/scripts/icons-requirements.txt
npm run icons
```

重新导入同结构的设计稿：

```sh
python mobile/scripts/icons.py --source design/icon-candidates/voice-white-v1/lingua-icon.svg
```

生成器使用 resvg 渲染原始渐变、圆角和阴影；Android 单色路径从 SVG 的圆角音频条提取。
若更换 SVG 的结构或变换形式，需要同步调整生成器的形状提取逻辑。

| 平台 / 用途 | 资源与规范 |
| --- | --- |
| 浏览器标签、收藏夹 | `web/favicon.ico` 含 16、32、48、64、256px；另提供 32px PNG 和可缩放 SVG。两个入口均声明图标，使用相对路径兼容子目录部署。 |
| iOS 网页主屏幕 | `web/icons/apple-touch-icon.png`，180px、不透明、方形，由系统裁圆角。 |
| 网页安装图标 | `web/manifest.webmanifest` 提供 192/512px 普通图标与独立 512px maskable 图标；原图主体及阴影已位于半径 40% 的安全圆内，无需额外缩小。清单用于安装元数据，离线能力仍以应用现有行为为准。 |
| Safari 固定标签页 | `safari-pinned-tab.svg` 是透明背景黑色轮廓，标签颜色在 HTML 中指定。 |
| iOS 原生 | `AppIcon-512@2x.png` 为 1024px RGB PNG，无透明通道、无预制圆角；沿用 Xcode universal AppIcon 配置，由资产编译器派生设备尺寸。 |
| Android 24–25 | 五档密度的 48dp PNG，分别提供透明外角的圆角方形与圆形图标。 |
| Android 26+ | 白色背景层与透明 108dp 前景层分离，前景按 72/108 缩放，保持系统 72dp 可视区域中的原图比例，并落在中央 66dp 安全圆内；由桌面决定最终轮廓。 |
| Android 33+ | 两种 adaptive-icon 均声明 monochrome 层，由系统主题着色；旧版系统忽略该层。不把白色背景或阴影放入单色轮廓。 |
| Android 媒体通知 | `ic_stat_lingua.xml` 为 24dp 白色透明底矢量轮廓，主体约 20dp；通知栏按 alpha 着色。播放、暂停等操作按钮继续表达各自操作。 |
| 启动屏 | iOS 及 Android 横竖屏 PNG 保留各自原尺寸，统一白底声纹。Android SplashScreen 主题明确设置背景、图标及启动后的主题，适配系统启动屏和 AndroidX 回退。 |

修改后运行 `npm test`（包含前端发布包校验），完成后再执行 `npx cap copy android`
和 Android 构建。测试会重建 `mobile/www`，不能与其他移动构建同时运行。
iOS 需在 macOS/Xcode 编译和验收。原生桌面图标和启动屏的更新需要重新构建、安装应用，
前端热更新无法替换这些原生资源。
