# Rail Log · 运转记录册（Beta 版）

一个 GitHub Pages 网站保存多次列车运行记录，共用互动图表，每次只新增记录数据。

- 首页：<https://ghj123h.github.io/rail-log/>
- G797 示例：<https://ghj123h.github.io/rail-log/viewer.html?id=260923162858>

## 使用

点击首页记录进入图表。滚轮或横向框选缩放时间轴，切换“拖动平移”查看相邻时段；双击或点击“全程”还原。

悬停速度曲线可查看北京时间、速度和速度精度；跨站与停车标记放在独立时间带，悬停才显示名称和起止时间。展开“区间标记”可编辑时间点或区间。

- **导出记录数据**：下载包含全部速度点和当前区间的 `YYMMDDHHMMSS.json`。将其替换到 `records/` 的同名文件并提交，即可更新网站。页面编辑本身不会修改仓库。
- **保存离线网页**：将图表组件、数据和当前标记打包为单文件 HTML，可用系统浏览器离线打开。

G797 的两段跨站区间是按已知通过时刻前后各 5 秒生成的测试数据：滕州东站 16:36:16–16:36:26，枣庄站 16:44:28–16:44:38。没有预填真实停车区间。

## 新增运行记录

需要 Python 3，无第三方 Python 依赖。原始日志放在本地仓库之外。

```powershell
python tools/manage_records.py import "原始日志路径.txt" --train G123 --origin 始发站 --destination 终到站 --partial
```

脚本从 GNSS Logger 的 `Fix` 记录读取 `UnixTimeMillis`、`SpeedMps` 和 `SpeedAccuracyMps`，不会导出经纬度。纯 NMEA 如果没有速度精度字段，无法用于此导入命令。

记录 ID 默认从 `gnss_log_YYYY_MM_DD_HH_MM_SS.txt` 文件名读取；其他文件名请添加 `--id YYMMDDHHMMSS`。只有记录不完整时才使用 `--partial`。

导入会生成 `records/<ID>.json` 并更新目录。先本地检查，然后提交并推送：

```powershell
git add records
git commit -m "Add running record"
git push
```

如果手工添加、删除或修改记录的车次、区间等信息，重新生成目录：

```powershell
python tools/manage_records.py rebuild
```

仅修改已有记录内的停车、跨站标记时，首页摘要不变，不需要重建目录。

## 本地预览

```powershell
python -m http.server 8766 --bind 127.0.0.1
```

打开 <http://127.0.0.1:8766/>。网站版本通过 HTTP 加载 JSON；离线使用请从记录页下载单文件 HTML。

## 文件结构

```text
index.html                 记录目录
viewer.html                共用查看器
assets/                    图表脚本、样式、ECharts 和第三方许可
records/index.json         首页摘要
records/<ID>.json          一次运行的数据与标记
tools/manage_records.py    导入日志与更新目录
```

每条记录包含 `id`、`title`、`train`、`origin`、`destination`、`partial`、`logStart`、`logEnd`、`sampleIntervalMs`、`samples` 和 `events`。

`samples` 的每个元素为 `{t, v, a}`：UTC Unix 毫秒时间戳、km/h 速度、km/h 速度不确定度。`events` 的每个元素为 `{id, name, type, start, end}`，`type` 为 `pass` 或 `stop`，起止为 UTC Unix 毫秒时间戳。显示与输入时间均为北京时间 UTC+8，支持跨日期。

曲线保留原始采样，不做平滑。超过正常采样间隔 1.5 倍的间断留空。色带为速度 ± 设备报告的速度精度（约 68% 置信水平），下限取 0。

## 发布

GitHub 仓库 Settings → Pages → Deploy from a branch → `main` / `(root)`。`.nojekyll` 使网站按普通静态文件发布，无需构建服务或数据库。

Apache ECharts 6.0.0 采用 Apache License 2.0；完整许可与 NOTICE 位于 `assets/`。
