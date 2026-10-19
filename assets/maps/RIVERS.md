# 黄河、长江主干水系

`major-rivers.geojson` 仅提供黄河、长江的主干河流中心线，不包含支流、湖泊面、行政区或国界。黄河主体与长江宜宾以上使用 Natural Earth，黄河入海尾段及长江宜宾以下使用 OpenStreetMap 主流。河口按当前网页使用的 DataV 底图岸线作末端对齐。两种源坐标均原生为 **WGS84**，经纬度单位为度，直接与 GNSS 经纬度叠加，无须 GCJ 转换。

## Natural Earth 来源快照

- 官方下载：<https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_rivers_lake_centerlines.zip>
- 数据说明：[1:10m Rivers + Lake Centerlines](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-rivers-lake-centerlines/)，版本 **5.0.0**。1:10m 指 **1:1000 万比例尺**，并非 10 米空间分辨率；这些中心线经过制图概括。
- 下载日期：2026-10-19；压缩包大小：2,079,507 字节。
- SHA-256：`ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38`。
- 坐标定义来自压缩包 `.prj`：`GCS_WGS_1984`。
- Natural Earth 的[官方使用条款](https://www.naturalearthdata.com/about/terms-of-use/)将其栅格与矢量数据置于 **Public Domain（公共领域）**，允许修改和电子传播，无须取得额外许可或署名。这里仍保留来源，以便核对。

## OpenStreetMap 来源快照与许可

- 长江源关系：[relation 9392345](https://www.openstreetmap.org/relation/9392345)，`type=waterway`、`waterway=river`、`wikidata=Q5413`。
- 官方 API 快照：<https://api.openstreetmap.org/api/0.6/relation/9392345/full.json>，2026-10-19 下载，864,378 字节；关系版本 **68**，关系时间戳 **2026-07-16T00:01:17Z**。
- 原始完整响应 SHA-256：`c4b9c087cad03342733277cfa26c6f030ca429f2384a051d83e272e42b391ad1`。
- 仅选择关系中明确标为 **`main_stream` 的 65 个 way**，排除 23 个 `side_stream`。源关系的成员首尾均以相同节点连接，宜宾以下没有数据断口。入海主流沿源关系指定的长江南支、南港、北槽；原始航道中心线延伸到 `[122.368469,30.993503]`，最终图示按下述外口门截短，不额外绘制平行支汊。
- 黄河实际入海尾段为 [way 29544745](https://www.openstreetmap.org/way/29544745)，在黄河关系 `171843` 中标为 `main_stream`。官方快照 <https://api.openstreetmap.org/api/0.6/way/29544745/full>，2026-10-19 下载，25,768 字节；way 版本 **30**，更新日期 **2025-09-30**。原始响应 SHA-256 为 `ddb301d5348667dd7196f56436afe3b4c53f460b2d542a639463090bc809d408`。该段实际入海端点为 `[119.254313,37.8678896]`。
- **© OpenStreetMap contributors**。OSM 数据根据 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)提供，使用与署名要求见 [OpenStreetMap Copyright](https://www.openstreetmap.org/copyright)。本文件作为包含 OSM 提取数据的派生数据库按 **ODbL 1.0** 分发，公开数据与修改方法随 GeoJSON 和构建脚本提供；Natural Earth 原始数据仍为公共领域。网页及离线网页保留可见 OSM 署名和许可链接。

## 筛选与覆盖

以下为源数据明确命名的同一主干河道段；不通过支流拼接河道，不补画线段，不修正中心线位置。

| 展示名称 | 源 `ne_id` | 源名称与分类 |
| --- | --- | --- |
| 黄河 | 1159124945 | Huang / Lake Centerline，黄河自身穿越上游湖泊的中心线 |
| 黄河 | 1159124959、1159128895 | Huang / River |
| 长江 | 1159112047 | Tuotuo / River（沱沱河） |
| 长江 | 1159112343 | Tongtian / River（通天河） |
| 长江 | 1159112733 | Jinsha / River（金沙江） |
| 长江 | 1159113509 | Chang Jiang / River，仅保留与金沙江相接、位于宜宾接头之前的源顶点 |

同一条河的源分段仅在端点已有相同经纬度时合并。Natural Earth 的长江下游数据止于镇江附近，因此宜宾以下全部采用完整 OSM 主流，没有叠加旧的 NE 下游线。宜宾以上的 NE `Chang Jiang` 段裁剪到距离 OSM 宜宾起点最近的已有源顶点 `[104.621973,28.790302]`，不添加上游资料中不存在的连接线。黄河旧入海尾段则在 NE 与实际 OSM 河道最后的几何交点 `[119.192231404,37.768847515]` 接入实际河道，移除该点以下偏南的旧尾线。输出坐标保留六位小数，不做额外平滑或简化。

NE 上游分段自有小范围断口；长江两源在宜宾的接头相距约 2.46 km，也保留为空缺。该接缝位于现有线路范围以外。通过与现有 GNSS 桥梁走廊交叉核对：台前附近黄河线在 `[115.933288,35.974429]` 相交，大胜关长江线在 `[118.630860,31.959800]` 相交；五峰山及镇江以东的长江河道由完整 OSM 主流覆盖。

## 与当前底图的河口对齐

河流和底图采用独立来源：NE 黄河旧尾端停在当前底图陆地内部，OSM 长江航道中心线则伸到三角洲外海。以下处理只改变两条河的末端，未修改底图。参照底图 `china-prefectures.geojson` 的 SHA-256 为 `630abef571181fb90fad067eb3e578b5caae05f58da9782451d378c1ae3bcc92`，具体对齐方法及坐标也保存在 GeoJSON 的 `properties.mouthAlignment`。

- **黄河终点 `[119.254285,37.874033]`**：采用 OSM 真实尾段后，其端点仍位于 DataV 所画岸线内约 0.7 km，沿实际末段方向最小延长 **683.106 m**，到当前岸线段 `[119.234278,37.877331]`—`[119.285998,37.868805]`。这是为同一底图所作的图示末端对齐，不将该延长段标为原始 OSM 记录。
- **长江终点 `[122.081869,31.235084]`**：用底图大陆南岸外缘 `[121.973208,31.018505]` 与横沙东南外缘 `[122.093033,31.257335]` 形成外口门弦，截取原主流与该弦的交点，删除其后伸向海上的航道尾线。该点保持在实际水中主流上，与口门两岸外缘平齐；没有把崇明西端的行政水面闭合线误作海岸，也没有将河心线拐向一侧陆岸。

坐标取整后，黄河终点到参照岸线段的平面距离、长江终点到参照口门弦的平面距离均小于 **0.1 m**；此数值仅描述输出几何的贴合，不表示源资料或现实岸线的测量精度。

## 格式与再生成

GeoJSON `FeatureCollection` 恰有两个要素，各提供 `bbox: [west,south,east,north]`，`properties` 为 `{kind:"river",name:"黄河"}` 或 `{kind:"river",name:"长江"}`，几何类型为 `MultiLineString`。集合属性保留坐标系、各来源的版本、源 URL、快照哈希、署名及许可链接。黄河为 **3 段、1,957 点**，长江为 **3 段、5,158 点**；资产大小为 163,587 字节。

在仓库根目录执行：

```powershell
python -X utf8 tools/build_rivers.py
```

脚本只用 Python 标准库；NE 源压缩包与两份 OSM 原始完整响应默认缓存在系统临时目录 `rail-log-rivers/`，可通过 `--cache-dir 路径` 指定。若已有缓存便不下载，并校验各自的固定快照哈希；读取已保存的行政底图作河口对齐，若所用岸线节点改变则要求明确更新对齐依据。今后源响应改变时须明确更新快照，不能自动覆盖为不同数据。
