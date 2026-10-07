# Sources for the map layers in this folder

All files are GeoJSON FeatureCollections in WGS84 longitude/latitude (EPSG:4326), with coordinates rounded to 5 decimal places (about 1 m).
Study extent: longitude 36.60 to 37.10, latitude -1.45 to -1.15 (Nairobi County).
All source files were fetched on 7 October 2026.

## Attribution to show on the map

- Waterways, informal settlements and facilities: "© OpenStreetMap contributors" (Open Database License, ODbL 1.0, https://www.openstreetmap.org/copyright).
- County, sub-county and ward boundaries: "Ward boundaries: Omare, B.D.A. and Omare, G.J.M. (2017), Kenya County Assembly Boundaries, CC BY 4.0, distributed by geoBoundaries (https://www.geoboundaries.org)."

## nairobi-county.geojson, subcounties.geojson, wards.geojson

- Source: Kenya County Assembly (ward) boundaries digitised by Benedict Aboki Omare and George Omare (2017) from the IEBC 2012 boundary maps. This is the dataset geoBoundaries publishes as Kenya ADM3 ("Ward", boundaryID KEN-ADM3-90231094, geoBoundaries build of 12 December 2023).
- File used: https://raw.githubusercontent.com/benaboki/Kenya-County-Assembly-Boundaries/master/kenya_county_assemblies.geojson (1,452 wards for all of Kenya). The original file was used instead of geoBoundaries-KEN-ADM3.geojson because it keeps the county and constituency fields, which geoBoundaries removes. The ward shapes are the same in both.
- Processing:
  - wards.geojson: the 85 wards where the field county = "Nairobi". "name" is the source field "ward"; "subcounty" is the source field "const" (the IEBC constituency, which in Nairobi is also the sub-county). Roman numerals were capitalised ("Dandora Area Iii" became "Dandora Area III", and likewise for II and IV). One self-intersecting ring (Woodley/Kenyatta Golf) was repaired. No other name or shape edits.
  - subcounties.geojson: the 85 wards dissolved by "subcounty" (17 sub-counties).
  - nairobi-county.geojson: all 85 wards dissolved into one outline (area about 695 sq km).
  - The three layers come from one source, so wards nest exactly inside sub-counties and sub-counties inside the county.
  - No extra simplification was applied: the source is already generalised (about 2,100 vertices for all 85 wards).
  - Not clipped to the box: the county extends about 300 m east of longitude 37.10 (0.37 sq km). It was kept whole so the outline is complete.
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0).
- Citation for geoBoundaries: Runfola D, Anderson A, Baier H, Crittenden M, Dowker E, Fuhrig S, et al. (2020) geoBoundaries: A global database of political administrative boundaries. PLoS ONE 15(4): e0231866. https://doi.org/10.1371/journal.pone.0231866
- Checked against, not used in the files: geoBoundaries Kenya ADM1 (counties, RCMRD, public domain) and ADM2 (290 constituencies, IEBC and OCHA ROSEA, CC BY 3.0 IGO) from https://github.com/wmgeolab/geoBoundaries (releaseData/gbOpen/KEN/). Those outlines are more detailed but do not nest with the wards; the Nairobi outline differs from the RCMRD county outline by a few hundred metres in most places.

## waterways.geojson

- Source: OpenStreetMap.
- Files used:
  1. Geofabrik Kenya free shapefile, layer gis_osm_waterways_free_1 (OpenStreetMap data as of 2025-05-03 20:21 UTC). Fetched from a public copy in the GitHub repository Mitsuhiro-ODAKA/poverty-inequality-nairobi, folder data/raw/kenya-latest-free.shp/, because download.geofabrik.de could not be reached. The original is https://download.geofabrik.de/africa/kenya-latest-free.shp.zip. This gives the river, stream, canal and drain features ("kind" is the Geofabrik field "fclass", "name" is "name").
  2. The 18 waterway=ditch ways inside the box, taken from an OpenStreetMap PBF extract of Nairobi (Data/nairobi.osm.pbf in the public GitHub repository yokuta/r5pyForNairobi; extent longitude 36.65 to 37.15, latitude -1.40 to -1.10; newest object edited 2025-02-10). The Geofabrik layer leaves ditches out.
- Processing: features intersecting the box, clipped to the box (not to the county, so upstream reaches in Kiambu, Machakos and Kajiado inside the box are kept); simplified with mapshaper (3 m interval); 3 tiny clipped fragments that collapsed were dropped.
- Equivalent Overpass API query (for a refresh when Overpass is reachable):

```
[out:json][timeout:180];
way["waterway"~"^(river|stream|canal|drain|ditch)$"](-1.45,36.60,-1.15,37.10);
out geom;
```

- Licence: ODbL 1.0. Attribution: "© OpenStreetMap contributors".

## informal-settlements.geojson

- Source: OpenStreetMap, the Nairobi PBF extract described above (data up to 2025-02-10).
- Selection (closed ways and multipolygon relations):
  1. Areas tagged as informal: place=informal (11 found). No areas with residential=informal, informal=yes or settlement_type=slum exist in the extract (informal=yes appears only on 9 footpaths, and settlement_type=slum only on the Kibera place point, which has no outline).
  2. Residential or settlement areas (landuse=residential, or place=village, neighbourhood, suburb, quarter, locality or hamlet with no landuse tag other than residential) whose name contains one of: Kibera, Mathare, Mukuru, Korogocho, Kiambiu, Kawangware, Kangemi, the Kibera villages (Makina, Kianda, Soweto East, Soweto West, Raila, Gatwekera, Kisumu Ndogo, Kambi Muru, Lindi, Mashimoni, Silanga, Laini Saba), Kosovo, Mabatini, Kiamaiko, Gitathuru, Fuata Nyayo, Sinai, Lunga Lunga, Kisii Village, Gateway Village, Diamond Village, Githogoro, Deep Sea, Kayole Soweto, or the word "slum". Names containing flats, apartment, estate, drive, park, resettlement, upgrading, ward, sublocation, location, division, school or church were left out.
- Processing: clipped to the county outline; 2 areas outside the county were dropped (Mathare A and Mathare B, near Ngong); 9 areas lying mostly (more than half) inside an already selected area were dropped (Kibera Soweto East Zones C and D, four outlines inside Soweto East; Fuata Nyayo A, Fuata Nyayo B and Tumaini, Fuata Nyayo C; Korogocho A; Gitathuru). Explicitly tagged areas were selected first, then name matches from largest to smallest. No simplification.
- "source_tags" lists every OpenStreetMap tag of the area except name, as "key=value; key=value".
- Equivalent Overpass API query (then apply the name exclusions above):

```
[out:json][timeout:180];
(
  wr["place"="informal"](-1.45,36.60,-1.15,37.10);
  wr["landuse"="residential"]["name"~"kibera|mathare|mukuru|korogocho|kiambiu|kawangware|kangemi|makina|kianda|soweto east|soweto west|kayole soweto|raila|gatwekera|kisumu ndogo|kambi muru|lindi|mashimoni|silanga|laini saba|kosovo|mabatini|kiamaiko|gitathuru|fuata nyayo|sinai|lunga ?lunga|kisii village|gateway village|diamond village|githogoro|deep sea|slum",i](-1.45,36.60,-1.15,37.10);
  wr["place"~"^(village|neighbourhood|suburb|quarter|locality|hamlet)$"]["name"~"kibera|mathare|mukuru|korogocho|kiambiu|kawangware|kangemi|makina|kianda|soweto east|soweto west|kayole soweto|raila|gatwekera|kisumu ndogo|kambi muru|lindi|mashimoni|silanga|laini saba|kosovo|mabatini|kiamaiko|gitathuru|fuata nyayo|sinai|lunga ?lunga|kisii village|gateway village|diamond village|githogoro|deep sea|slum",i](-1.45,36.60,-1.15,37.10);
);
out geom;
```

- Coverage is partial. OpenStreetMap has outlines for most of Kibera (as its village boundaries), much of Mathare, Korogocho, Kayole Soweto, Githogoro, Kangemi and parts of Mukuru (Kayaba, Fuata Nyayo, Sinai, Lunga Lunga and nearby villages). It has no outlines for Kibera as a whole, Mukuru kwa Njenga, Mukuru kwa Reuben, Kawangware, Kiambiu and many smaller settlements. The Kangemi area is mapped as one residential area that also covers formal housing. Treat this layer as indicative, not complete.
- Licence: ODbL 1.0. Attribution: "© OpenStreetMap contributors".

## facilities.geojson

- Source: OpenStreetMap, the Nairobi PBF extract described above (data up to 2025-02-10).
- Selection: points and areas with amenity=hospital, clinic, school, fire_station or police, plus healthcare=hospital or clinic where the amenity tag is not one of these (3 features). "kind" is the amenity value, or the healthcare value for those 3.
- Processing: areas reduced to their centroid; an area was dropped when a point of the same kind inside it had the same name or either was unnamed (32 dropped, the point was kept); kept only inside the county outline (222 points outside it were dropped). The extract stops at latitude -1.40, so the southern tip of the county (about 21 sq km, mostly Nairobi National Park) is not covered.
- Equivalent Overpass API query:

```
[out:json][timeout:180];
(
  nwr["amenity"~"^(hospital|clinic|school|fire_station|police)$"](-1.45,36.60,-1.15,37.10);
  nwr["healthcare"~"^(hospital|clinic)$"](-1.45,36.60,-1.15,37.10);
);
out center;
```

- Licence: ODbL 1.0. Attribution: "© OpenStreetMap contributors".

## Sources that could not be reached

The Overpass API (overpass-api.de, overpass.kumi.systems, maps.mail.ru), download.geofabrik.de, the HDX site (data.humdata.org) and the geoBoundaries API (www.geoboundaries.org) were all blocked from the network used to prepare these files. The OpenStreetMap data therefore comes from the two public GitHub copies named above, which are older than a live download (February and May 2025). Running the Overpass queries above would give current data.
