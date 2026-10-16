# 兔兔碰碰 · 合成大兔兔

[手机浏览器开始游戏](https://liu030830.github.io/bunny-merge/)

拖动瞄准，松手投放；两只相同的兔兔碰撞后，合成更大的一只。

- 12 只各有特色的兔子，保留耳机、厨师帽、斗笠和躺姿等造型。
- 碰撞采用与兔子轮廓匹配的不规则实体，静止后休眠，避免一直旋转。
- 合成时轻轻向上弹起，并带有小幅放大回弹。
- 支持触屏、鼠标、方向键与空格，包含暂停、音效、兔兔图鉴和本地进度保存。
- 游戏资源全部同站打包，玩家无需登录 GitHub 或 ChatGPT。

## 本地运行

通过 HTTP 静态服务器运行此目录。不要直接双击 index.html，因为浏览器会限制本地 JavaScript 模块加载。

例如安装 Python 后运行：

```sh
python -m http.server 8000
```

访问 http://localhost:8000 。

## 托管

GitHub Pages 发布源为 main 分支的根目录。保留 assets/、vendor/ 和 .nojekyll，所有资源使用相对路径。

物理引擎采用 Matter.js 0.20.0，其 MIT 许可见 vendor/LICENSE。清除浏览器数据会清空本地最高分和游戏进度；不同网站的进度各自保存。