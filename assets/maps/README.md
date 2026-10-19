# 线路图底图

`china-prefectures.geojson` 是本地保存的无填色、无行政区名称边界线底图，不依赖运行时地图 API。它保留全国范围数据，网页按每次记录的线路范围裁切。

## 来源与口径

- 数据来自阿里云 [DataV.GeoAtlas 范围选择器](https://datav.aliyun.com/portal/school/atlas/area_selector)，使用 `areas_v3` 版本。阿里云的[范围选择器文档](https://help.aliyun.com/en/datav/datav-6-0/user-guide/introduction-to-range-selector-features)说明其数据来自高德开放平台，并提供 GeoJSON 下载。
- 源接口为 `https://geo.datav.aliyun.com/areas_v3/bound/{adcode}.json`，含下级区域的文件名为 `{adcode}_full.json`。本次下载日期为 **2026-10-19**，原始文件 URL、SHA-256 与字节数保存在 `sources.json`；下载日期不代表行政区划的生效日期。
- 保留源数据的中国国界及海岸线表示，不使用其他国家或全球地图数据替换争议区段，也不自行补画国界。抽查源数据：阿克赛钦代表点 `[79.6,35.2]` 位于新疆面内，达旺代表点 `[91.86,27.59]` 位于西藏面内，台湾代表点 `[121,23.7]` 位于台湾面内。源 `100000_JD` 的 10 段海上界线轮廓原样保留，仅统一坐标。
- 展示 333 个地级单位的边界；北京、天津、上海、重庆使用整体边界，不加载其区县。台湾、香港、澳门也保留整体轮廓，不细分。
- 河南、湖北、海南、新疆的省级直辖县级单位按同省合并为一个集合，消除集合内部的县与县边界；保留与周围地级单位相接的边界，不添加县级名称。具体合并代码见 `sources.json`。其他地级单位不下钻至区县。

## 坐标与几何

阿里云[地图数据格式文档](https://www.alibabacloud.com/help/zh/datav/datav-7-0/user-guide/map-data-format-1)将 DataV 主要使用的地图坐标说明为 **GCJ-02**。构建脚本据此对下载的边界执行一次 GCJ-02 → WGS84 数值反解，以便与原始 GNSS 经纬度在同一坐标体系内叠加；前端无需再次转换底图。数值反解用于图示对齐，不代表测绘精度保证。

输出是 GeoJSON `FeatureCollection`，经纬度顺序为 `[longitude, latitude]`，坐标保留 6 位小数，未投影。集合的 `properties.coordinateSystem` 为 `WGS84`。每个要素提供 `bbox: [west,south,east,north]`，几何均为 `MultiLineString`：

| `properties.kind` | 内容 |
| --- | --- |
| `administrative` | 省内地级边界，以及国界外沿、海岸和岛屿轮廓 |
| `provincial` | 相邻省级单位之间的共有边界，包含直辖市外界；前端使用粗实线 |
| `national` | 源数据单独提供的 `100000_JD` 海上界线轮廓 |

省界、直辖市边界、海岸线和国界外沿统一使用全国省级文件 `100000_full.json` 的轮廓，共有边只绘制一次。其中由两个以上省级面共有的边单独归入 `provincial`，不在 `administrative` 重复保留。各省 `_full.json` 仅提取省内相邻地级单位之间的共有边，不叠加其省级外沿，以免不同层级数据的简化差异形成交叉双线。未叠加更粗的 `100000.json` 外沿；该文件的来源哈希仍保留以核对全国口径。边界网在公共节点处分段后按 0.0005 度容差简化，省界与地级边界分层时保留共同连接点，保留小岛闭环；`national` 的界线轮廓不简化。前端只描边，不填充这些几何，也不添加行政区文字。

## 生成

在仓库根目录运行：

```powershell
python -X utf8 tools/build_basemap.py
```

只使用 Python 标准库。源文件默认缓存到系统临时目录的 `rail-log-datav-basemap/`，不提交进仓库。可以使用 `--cache-dir 路径` 指定缓存。上游数据会更新；如需刷新，使用一个新的空缓存目录。当前快照包含 991 条行政边界折线、182 条省界折线和 10 条海上界线轮廓，共 60,036 个坐标点。

## 许可与署名

边界来源署名为 **阿里云 DataV.GeoAtlas / 高德开放平台**。DataV 文档明确提供下载并将下载的 GeoJSON 上传至自己的服务器或 OSS 的用法，见[区域热力层文档](https://help.aliyun.com/zh/datav/datav-7-0/user-guide/choropleth-layers-of-v3-x)。本目录未将地图数据重新标为 MIT、公共领域或其他开源数据许可；所查源接口及相关文档未单独提供这份边界数据的开源许可证。

构建脚本的 GCJ 偏移公式改写自 [wandergis/coordtransform](https://github.com/wandergis/coordtransform)（MIT），完整许可保留在 `LICENSE-coordtransform.txt`。该软件许可不适用于第三方边界数据。
