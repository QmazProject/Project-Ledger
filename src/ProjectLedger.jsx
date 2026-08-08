import { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase, isConfigured } from "./lib/supabase";

/* ==================================================================
   Project Ledger — QM Builders
   Attributes : PROJECT_MASTER_DATA.xlsx › "QMB PROJECTS" + "QM LICENSES"
   Money      : UPDATED COLLECTIBLES.xlsx › "COLLECTIBLES"
   Both files can be re-imported in the browser to refresh the figures.
================================================================== */

const SNAP_FIELDS = ["id","name","district","license","engineer","category","location",
  "status","office","year","contract","billpct","gross","net","cg","cc","cr","bal","netbal","remarks","swa"];

const SNAPSHOT = [["2024-INFRA-8","Supply of Labor, Materials and Equipment for the Proposed Coastal Development Project (Sheet Pile Revetment - Phase 4) at Reclamation Phase 3, Brgy. North Poblacion, City of Naga, Cebu","LGU NAGA","QM BUILDERS","PARVANI ABATAYO","FLOOD CONTROL","NAGA CITY, CEBU","ONGOING","CITY OF NAGA",2024,99895000.0,0.15,14984250.0,14984250.0,84910750.0,0.0,0.0,84910750.0,78667312.5,"",0.6966],["21HG0161","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Rehabilitation/Reconstruction of Roads with Slips, Slope Collapse, and Landslide - Secondary Roads, Santander-Barili-Toledo Road - K0162+582.00 - k0162+698.00, Malabuyoc, Cebu","CEBU 2ND","UNSPECIFIED","UNASSIGNED","ROADS","MALABUYOC, CEBU","COMPLETED","DPWH Cebu 2nd DEO",2021,29399991.0,1.0,29399991.0,26092492.01,0.0,0.0,1469999.5499999998,1469999.5499999998,1469999.5524999984,"",1.0],["21HG0162","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Rehabilitation/Reconstruction of Roads with Slips, Slope Collapse, and Landslide - Secondary Roads, Santander-Barili-Toledo Road - K0162+698.00 - k0162+710.00, Malabuyoc, Cebu","CEBU 2ND","UNSPECIFIED","UNASSIGNED","ROADS","MALABUYOC, CEBU","COMPLETED","DPWH Cebu 2nd DEO",2021,4900000.0,1.0,4900000.0,4246455.67,0.0,0.0,347294.33,347294.33,347294.3300000001,"",1.0],["22HO0013","001: Ensure Safe and Reliable National Road System - Asset Preservation - Preventive Maintenance - Tertiary Roads - Argao - Ronda Rd. K0084+858 - K0085+464","CEBU 7TH","QM BUILDERS","UNASSIGNED","ASPHALTING","RONDA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2022,18919229.65,1.0000000000000002,18919229.650000002,17736777.791875,0.0,null,0.0,0.0,0.004999998956918716,"RET 6/18/26",1.0],["23H00016","Organizational Outcome 1: Ensure Safe and Reliable Ntaional Road System, Netwrok Development Program, Construction of By-pass ans Diversion Roads, Metro Cebu Expressway Package 1, Cebu","REGION VII","QM BUILDERS","KEVIN ALVIZO","SLOPE PROTECTION","PANGDAN, NAGA CITY","SUSPENDED","DPWH Region VII",2023,144749958.98,0.9001425594739053,130295598.56,122152123.658,14454360.419999987,0.0,0.001999998465180397,14454360.421999985,13550962.88574998,"",0.9912],["23H00017","Organizational Outcome 1: Ensure Safe and Reliable National Road System, Netwrok Development Program, Construction of By-pass ans Diversion Roads, Metro Cebu Expressway Package 2, Cebu","REGION VII","QM BUILDERS","KEVIN ALVIZO","ROADS","PANGDAN, NAGA CITY","SUSPENDED","DPWH Region VII",2023,133169997.84,0.9500450214920572,126517493.46000001,115877852.37349999,6652504.379999995,0.0,2732297.7640000004,9384802.143999996,8969020.60150002,"",0.9652],["23H00018","Organizational Outcome 1: Ensure Safe and Reliable Ntaional Road System, Netwrok Development Program, Construction of By-pass ans Diversion Roads, Metro Cebu Expressway Package 3, Cebu","REGION VII","QM BUILDERS","KEVIN ALVIZO","ROADS","PANGDAN, NAGA CITY","SUSPENDED","DPWH Region VII",2023,96499996.19,0.9000267028922461,86852573.4,81424287.585625,9647422.789999992,0.0,0.0,9647422.789999992,9044458.842500001,"",0.8659],["23H00062","Local Program, National Building Program, Buildings And Other Structures - Multipurpose/ Facilities, Construction of Employees Quarters, DPWH Regional Office VII, South Road Properties, Cebu City","REGION VII","QM BUILDERS","KEVIN ALVIZO","BUILDING","SRP, CEBU CITY","COMPLETED","DPWH Region VII",2023,48249997.42,1.0,48249997.42,45234372.61,0.0,0.0,0.0,0.0,0.0,"",0.906],["23H00065","Local Program, National Building Program, Buildings And Other Structures - Multipurpose / Facilities, Construction of Training Facilities and Central Record Depository Building, DPWH Regional Office VII, South Road Properties, Cebu City","REGION VII","QM BUILDERS","KEVIN ALVIZO","BUILDING","SRP, CEBU CITY","COMPLETED","DPWH Region VII",2023,67449999.85,0.9013310968895429,60794782.35,50599458.33,6655217.499999993,0.0,6079478.24,12734695.739999993,12634916.529374994,"",0.7379],["23H00107","Rehabilitation/Reconstruction of Toledo-Pinamungajan-Aloguinsan-Mantalongon Road, K0075+000 - K0075+200 L/S and K0076+000 - K0076+100 L/S with Slips, Slope Collapse and Landslide","REGION VII","QM BUILDERS","RAYMOND MANGUILIMOTAN","SLOPE PROTECTION","CEBU PROVINCE","COMPLETED","DPWH Region VII",2024,156276000.0,1.0,156276000.0,146275000.01,0.0,0.0,0.0,0.0,0.0,"RET 6/23/26",1.0],["23H00109","REHABILITATION / RECONSTRUCTION OF SANTANDER - BARILI - TOLEDO ROAD, K0065+200 - K0065+500 L/S WITH SLIPS, SLOPE COLLAPSE AND LANDSLIDE, CEBU PROVINCE","REGION VII","QM BUILDERS","GIL AMORIN","SLOPE PROTECTION","CEBU PROVINCE","COMPLETED","DPWH Region VII",2024,168875000.0,1.0,168875000.0,157835312.5,0.0,0.0,0.0,0.0,0.0,"RET 6/23/26",1.0],["23H00113","COVERAGE AND SPECIAL SUPPORT PROGRAM, SUSTAINABLE INFRASTRUCTURE PROJECTS ALLEVIATING GAPS (SIPAG) - ACCESS ROADS AND/OR BRIDGES FROM THE NATIONAL ROAD/S LEADING TO MAJOR/STRATEGIC PUBLIC BUILDINGS / FACILITIES, ROAD CONCRETING OF SRP BACK ROAD (PHASE III), CEBU CITY","REGION VII","QM BUILDERS","KEVIN ALVIZO","SLOPE PROTECTION","SRP","COMPLETED","DPWH Region VII",2024,289356885.1,1.0,289356885.1,254049989.11,0.0,0.0,17222090.71,17222090.71,17222090.671249986,"",0.9998],["23H00117","Local Program, National Building Program, Buildings And Other Structures, Construction of 3-Storey Office Bldg - DPWH Cebu 4th DEO, Dalaguete, Cebu","REGION VII","QM BUILDERS","JASON CARIN","BUILDING","DALAGUETE, CEBU","ONGOING","DPWH Region VII",2024,77199684.02,0.7481302308832948,57755417.43,50110013.278749995,19444266.589999996,0.0,4737252.88,24181519.469999995,22264690.490000002,"",0.6169],["23HE0164","CONVERGENCE AND SPECIAL SUPPORT PROGRAM (CSSP) \u2013 SUSTAINABLE INFRASTRUCTURE PROJECTS ALLEVIATING GAPS (SIPAG) \u2013 ACCESS ROADS AND/OR BRIDGES FROM THE NATIONAL ROADS LEADING TO MAJOR/STRATEGIC PUBLIC BUILDINGS/FACILITIES \u2013 CONSTRUCTION OF CEBU-TOLEDO WHARF ROAD LINAO-CANTABACO SECTION, TALISAY CITY, CEBU","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2023,96500000.0,1.0,96500000.0,90468749.994375,0.0,0.0,0.0,0.0,0.0,"RET 7/23/26",0.3802],["23HF0113","RECONSTRUCTION OF FLOOD CONTROL ALONG SANTANDER -BARILI - TOLEDO ROAD, KM0065+400 - KM0065+700, BRGY. MINOLOS, BARILI CEBU","CEBU 3RD","QM BUILDERS","GIL AMORIN","FLOOD CONTROL","BARILI, CEBU","COMPLETED","DPWH Cebu 3rd DEO",2024,92108285.0,1.0,92108285.0,86351517.19000001,0.0,0.0,0.0,0.0,-0.002500012516975403,"RET 6/2/26",1.0],["23HF0116","REPAIR/REHABILITATION OF ROADSIDE PROTECTION ALONG TOLEDO - TABUELAN - SAN REMIGIO ROAD, K0102+180 - KM 102+450, BRGY. BAGASAWE TUBURAN, CEBU","CEBU 3RD","QM BUILDERS","JOAN CAPALAC","SLOPE PROTECTION","TUBURAN, CEBU","COMPLETED","DPWH Cebu 3rd DEO",2024,95698981.72,1.0,95698981.72,89717795.36,0.0,0.0,0.0,0.0,0.0,"ret collected 3/18/26",1.0],["23HG0089","Reconstruction/Improvement of Damaged Manlapay Bridge along Dalaguete-Mantalongon-Badian Road including Slope Protection Structure, Dalaguete, Cebu","CEBU 2ND","QM BUILDERS","JASON CARIN","BRIDGE","DALAGUETE, CEBU","COMPLETED","DPWH Cebu 2ND DEO",2024,67106000.0,1.0,67106000.0,62911875.0,0.0,0.0,0.0,0.0,0.0,"ret 5/26/26",1.0],["23HK0054","Construction/Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers: Construction of Banica River Control, Bantinguel, Dumaguete City, Negros Oriental","NEGROS 2ND","QM BUILDERS","CHARISSA DAGO-OC","FLOOD CONTROL","DUMAGUETE CITY, NEGROS","COMPLETED","DPWH NEGROS 2nd DEO",2023,49000000.0,1.0,49000000.0,45937500.0,0.0,0.0,0.0,0.0,0.0,"",1.0],["23HN0160","CSSP: Basic Infrastructure Program (BIP) Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities Construction of Cordova-Lapu-Lapu City Bridge","CEBU 6TH","QM BUILDERS/ ADAMANT DEVELOPMENT CORPORATION JV","UNASSIGNED","BRIDGE","LAPU-LAPU CITY, CEBU","COMPLETED","DPWH Cebu 6th DEO",2023,98840000.0,1.0,98840000.0,92662500.0,0.0,0.0,0.0,0.0,0.0,"ret collected 3/16/26",1.0],["23HO0006","Convergence and Special Support Program, Basic Infrastructure Program (BIP), Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities, Construction of Road, Barangay Colabtingon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96453588.35,1.0000000000000002,96453588.35000001,84722082.31687501,0.0,0.0,5703156.77,5703156.77,5703156.761249989,"",1.0],["23HO0017","Convergence and Special Support Program, Basic Infrastructure Program (Bip), Access Roads and/or BRIDGES FROM THE NATIONAL Road/s leading to Major/Strategic Public Buildings/Facilities, Construction of Road, Barangay Kantangkas, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96401603.72,1.0,96401603.72,85470951.36625001,0.0,0.0,4905552.12,4905552.12,4905552.121249989,"",1.0],["23HO0078","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Coastal Roads/Causway for Environmental Protection/ Conservation, Construction of Road, Barangay Kantangkas, (Package 2), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96492444.19,1.0,96492444.19,84155469.55000001,0.0,0.0,6306196.88,6306196.88,6306196.878124982,"",1.0],["23HO0093","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Multi-purpose Buildings/ Facilities to support Social Services, Construction of Ginatilan Multi-Purpose Building (Sports Complex Coliseum), Ginatilan, Cebu","CEBU 7TH","QM BUILDERS/ QG DEVELOPMENT CORPORATION JV","UNASSIGNED","BUILDING","GINATILAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2023,77192292.1,0.8950103660673657,69087901.61000001,60254013.25,8104390.48999998,0.0,4515894.52,12620285.00999998,12113760.59375,"",0.0],["23HO0095","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Construction/Improvement of Access Roads leading to Seaports (Kalsada Tungo sa Paliparan, Riles at Daungan Program - KATUPARAN), Rehabilitation of Moalboal Municipal Wharf, Moalboal, Cebu","CEBU 7TH","QM BUILDERS","JUDE NATAD","BUILDING","MOALBOAL, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,48998225.54,1.0,48998225.54,45935836.439553596,0.0,0.0,0.0,0.0,0.0041964054107666016,"RET 5/26/26",1.0],["23HO0101","Convergence and Special Support Program (CSSP): Basic Infrastructure Program - Access Roads and/or Bridges from the National Road/s leading to Major Strategic Public Buildings/Facilities, Construction of Road, Barangay Colabtingon (Package 2), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96453774.74,1.0,96453774.74,85043139.49937502,0.0,0.0,5382274.32,5382274.32,5382274.319374979,"",1.0],["23HO0103","Convergence and Special Support Program (CSSP): Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/ Facilities, Construction of talayong Bridge, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","BRIDGE","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,67548190.12,1.0,67548190.12,63326428.2436,0.0,0.0,0.0,0.0,-0.006099998950958252,"RET 5/28/26",1.0],["23HO0104","Convergence and Special Support Program (CSSP): Construction/ Rehabilitation of Water Supply/Septage and Sewerage/ Rain Water Collectors, Construction of Water Supply Systems and Facilities for DPWH - Cebu 7th DEO Compound, Barangay Cogon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,33783000.0,1.0,33783000.0,28293262.51,0.0,0.0,3378300.0,3378300.0,3378299.9899999984,"",0.9673],["23HO0125","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance \u2013 Secondary Roads, Santander-Barili-Toledo Rd \u2013 K0208+831 \u2013 K0120+000, K0211+000 \u2013 K0212+156;","CEBU 7TH","QM BUILDERS","JUDE NATAD","ASPHALTING","RONDA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,72363005.6,1.0,72363005.6,67840317.74625,0.0,0.0,0.0,0.0,0.0037499964237213135,"RET 5/26/26",1.0],["23HO0127","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Tertiary Roads, Sibonga-Dumanjug K0081+038 - K0082+023 with installation of road safety devices solar studs and solar street lights","CEBU 7TH","QM BUILDERS","JUDE NATAD","ROADS","RONDA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96498229.39,1.0000000000000002,96498229.39000002,90467090.04875,0.0,0.0,0.0,0.0,0.004374995827674866,"RET 5/26/26",0.8205],["23HO0161","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Dumanjug Bypass Road, Barangay Cogon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96414658.64,0.29579953299931117,28519411.0,21984452.8125,67895247.64,0.0,4752495.0,72647742.64,68404289.6625,"",1.0],["23HO0174","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Bridge Program, Replacement of Bridges (Temporary to Permanent), Manduyong Bridge along Santander-Barili-Toledo Road - K0195 + 198 - K0195 + 220","CEBU 7TH","QM BUILDERS","JASON CARIN","BRIDGE","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,144743076.49,1.0,144743076.49,135696634.21,0.0,0.0,0.0,0.0,0.0,"RET 3/30/26",1.0],["23HO0175","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Matalao - Barangay Lamac, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96491782.02,1.0,96491782.02,85709295.62937501,0.0,0.0,4751750.0,4751750.0,4751750.014374986,"",0.9508],["23HO0176","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Matalao - Barangay Balaygtiki, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96497459.15,0.9999999999999999,96497459.14999999,85706159.770625,0.0,0.0,4760208.19,4760208.19,4760208.182500005,"",0.9773],["23HO0197","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Bridge at Kantangkas-Colabtingon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS/ QG DEVELOPMENT CORPORATION JV","GERISZA CARLA ENERO","BRIDGE","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2023,96496975.14,0.8907254787551467,85952314.38,77209916.81,10544660.760000005,0.0,4831326.87,15375987.630000006,13255997.383749992,"",0.8824],["23HO0204","Local Program (LP), Buildings and Other Structures - Multipurpose / Facilities, National Building Program, Construction of Hazardous Waste Storage Building at DPWH Cebu 7th DEO Compound,Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,29397808.65,1.0,29397808.65,26111646.57,0.0,0.0,1448799.04,1448799.04,1448799.0393749997,"",1.0],["23HO0225","Organizational Outcome 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Drainage System along Brgy. Tunga, Moalboal, Cebu","CEBU 7TH","QM BUILDERS","JUDE NATAD","FLOOD CONTROL","MOALBOAL, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,26457957.62,1.0,26457957.62,24804335.270000003,0.0,0.0,0.0,0.0,-0.001250002533197403,"RET 5/26/26",1.0],["23HO0234","Construction of Modified Standard DPWH - DEPED Three (3) Storey, Twelve (12) Classroom School Building at Lawaan Elementary School, Alcantara, Cebu","CEBU 7TH","QM BUILDERS","JUDE NATAD","BUILDING","ALCANTARA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,58108000.0,1.0,58108000.0,54476249.99999999,0.0,0.0,0.0,0.0,0.0,"RET 6/4/26",1.0],["23HO0248","Convergence and Special Support Program, Special Road Fund - Motor Vehicle User's Charge (MVUC), Installation of Solar LED Street Lights along Santander-Barili-Toledo Rd, Ginatilan Section, Ginatilan, Cebu","CEBU 7TH","QM BUILDERS/ EC SOLICON BUILDERS AND SUPPLY INC. JV","JASON CARIN","STREETLIGHTS","GINATILAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,114832807.97,0.9999999999999999,114832807.96999998,107655757.47,0.0,0.0,0.0,0.0,0.0,"RET 3/30/26",1.0],["23HO0249","OrganizationalOutcome2:ProtectLivesandPropertiesAgainstMajorFloods,FloodManagementProgram,Construction/MaintenanceofFloodMitigationStructuresandDrainageSystems,Constructionof Revetment Wall at Brgy.Matalao(Downstream), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96496218.07999998,1.0,96496218.07999998,90465204.450625,0.0,0.0,0.0,0.0,0.0,"",1.0],["23HO0264","Organizational Outcome 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Revetment Wall at Brgy. Balaygtiki (Downstream), Dumanjug , Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,28656000.0,1.0,28656000.0,25412285.759999998,0.0,0.0,1452714.24,1452714.24,1452714.240000002,"",1.0],["23HO0265","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Mahor/ Strategic Public Buildings/ Facilities, Construction of By-Pass Road, Barangay Paculob-Barangay Cogon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95049000.0,0.3085556484550074,29327905.83,24562121.139999993,65721094.17,0.0,2932790.58,68653884.75,64546316.36000001,"",0.8108],["23HO0266","Convergence and Special Support Program, Basic Infrastructure Program (BIP), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction (Road Opening) of Brgy. Cogon - Brgy. Liong, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2023,96492292.1,1.0,96492292.1,85706021.37,0.0,0.0,4755502.49,4755502.49,4755502.473749995,"",0.9644],["23HO0282","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Dalaguete-Mantalongon-Badian Road Package 3, Barangay Talayong-Barangay Basak, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,142577000.0,0.8933526283341633,127371537.69,112244611.2,15205462.310000002,0.0,7166205.39,22371667.700000003,21421326.299999997,"",0.7],["23HO0283","Organizational Outcome 1: Ensure Safe and Reliable National Road System, Network Development Program, Road Widening - Secondary Roads, Santander-Barili-Toledo Rd K0178+000 - K0178+177","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","ALEGRIA, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,142569500.0,0.5561603140222838,79291497.89,66406629.48,63278002.11,0.0,7929149.789000001,71207151.899,67252276.77000001,"",0.6928],["23HO0285","Organizational Outcome 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Revetment Wall at Brgy. Kantangkas (Upstream), Dumanjug ,Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,95049500.0,0.8898708985318177,84581783.97,74477872.87,10467716.030000001,0.0,4817549.6,15285265.63,14631033.379999995,"",1.0],["23HO0293","Convergence and Special Support Program, Special Road Fund - Motor Vehicle User's Charge (MVUC), Installation of Solar LED Street Lights along Secondary Road, Santander-Barili-Toledo Rd, (Ronda-Dumanjug Section), Ronda, Cebu","CEBU 7TH","QM BUILDERS/ EC SOLICON BUILDERS AND SUPPLY INC. JV","GLICERIO BRA\u00d1ANOLA","STREETLIGHTS","RONDA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,118861000.0,1.0,118861000.0,111432187.5,0.0,0.0,0.0,0.0,0.0,"RET 6/16/26",0.8757],["23HO0294","Convergence and Special Support Program, Sustainablle Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Alegria Seawall Protection Structure (Package 2), Alegria, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","ALEGRIA, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95046500.0,0.8228222601568707,78206375.95,67600463.03,16840124.049999997,0.0,5718014.43,22558138.479999997,21505630.72,"",0.6974],["23HO0295","Convergence and Special Support Program, Basic Infrastructure Program (BIP), Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities, Construction (Road Opening) of Brgy. Matalao - Brgy. Balaygtiki Road (Phase II), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95813000.0,0.8940227739450806,85659004.04,71739415.88,10153995.959999993,0.0,8565900.4,18719896.359999992,18085271.620000005,"",0.6131],["23HO0302","Organizational Outcome 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Slope Protection Structure along Basak Section, Badian, Cebu (Phase II)","CEBU 7TH","QM BUILDERS","JASON CARIN","SLOPE PROTECTION","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,66535000.0,1.0,66535000.0,62376562.5,0.0,0.0,0.0,0.0,0.0,"ret 4/30/26",1.0],["23HO0306","Organizational Outcome 1: Ensure Safe and Reliable National Road System, Network Development Program, Construction of By-Pass and Diversion Roads, Dumanjug By-Pass Road, Brgy. Cogon (Phase II), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95048000.0,0.8342603289916674,79294775.75,66409374.69,15753224.25,0.0,7929477.58,23682701.83,22698125.310000002,"",0.4696],["23HO0307","Convergence and Special Support Program, Basic Infrastructure Program (BIP), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction (Road Opening) of Brgy. Matalao - Brgy. Lamac Road (Phase II), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95813000.0,0.8915951024391262,85426401.55,74211602.4,10386598.450000003,0.0,7433568.397,17820166.847000003,15613085.099999994,"",0.2601],["23HO0314","Convergence and Special Support Program, Special Road Fund - Motor Vehicle User's Charge (MVUC), Installation of Solar LED Street Lights along Santander-Barili-Toledo Rd, Badian Section, Badian, Cebu","CEBU 7TH","QM BUILDERS/ EC SOLICON BUILDERS AND SUPPLY INC. JV","JASON CARIN","STREETLIGHTS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,94050000.0,0.8978387423710792,84441733.72,73451286.71000001,9608266.280000001,0.0,5712838.66,15321104.940000001,14720588.289999992,"",0.9943],["23HO0344","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Flood Mitigation Structures protecting Public Infrastructures/ Facilities, Construction of River Control Structure at Barangay Paculob - Barangay Ylaya, (Upstream), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,67549593.63,0.51346308165792,34684222.51,29048036.35,32865371.119999997,0.0,3468422.25,36333793.37,34279707.678124994,"",0.3717],["23HO0345","Organizational Outcome 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Revetment Wall at Brgy. Colabtingon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,48249596.39,1.0,48249596.39,45233996.61624999,0.0,0.0,0.0,0.0,-0.0006249919533729553,"RET 5/28/26",1.0],["23HO0346","ORGANIZATIONAL OUTCOME 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Flood Wall Structures along Sitio Parale (Left Side), Barangay Sorsogon, Malabuyoc, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","MALABUYOC, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,43424960.5,1.0,43424960.5,40710900.47,0.0,0.0,0.0,0.0,-0.0012499988079071045,"RET 5/28/26",0.9098],["24GH0065","Construction of Flood Control Structure, Barangay Mangorocoro, Ajuy, Iloilo","ILOILO 3RD","QM BUILDERS","JOAN CAPALAC","FLOOD CONTROL","AJUY, ILOILO","COMPLETED","DPWH ILOILO 3RD DEO",2024,96500000.0,1.0,96500000.0,84661184.61,0.0,0.0,5807571.11,5807571.11,5807565.390000001,"",0.8752],["24GHO0052","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","COMPLETED","DPWH Cebu 7th DEO- SUPPLY",0,2996599.0,1.0,2996599.0,2836066.91,0.0,0.0,0.0,0.0,0.0007142857648432255,"",null],["24H00006","Local Program, National Building Program, Buildings And Other Structures \u2013 Multipurpose / Facilities, Construction of Employees Quarters, DPWH Regional Office VII, Phase II, South Road Properties, Cebu City","REGION VII","QM BUILDERS","KEVIN ALVIZO","BUILDING","SRP, CEBU CITY","COMPLETED","DPWH Region VII",2024,33474999.89,0.14999999989544438,5021249.98,4707421.87,28453749.91,0.0,0.0,28453749.91,26675390.526875,"",1.0],["24H00008","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Flood Mitigation Structures protecting Major/Strategic Public Buildings/ Facilities, Construction of Flood Mitigation Structure at Camanchilles River (Upstream), Brgy. Talavera, Toledo City, Cebu","REGION VII","QM BUILDERS","RAYMOND MANGUILIMOTAN","FLOOD CONTROL","TOLEDO CITY, CEBU","COMPLETED","DPWH Region VII",2024,192999998.88,1.0,192999998.88,180937498.95,0.0,0.0,0.0,0.0,0.0,"",1.0],["24H00033","Organizational Outcome 1: Ensure Safe and Reliable National Road System, Network Development Program, Construction of By- Pass and Diversion Roads, Metro Cebu Expressway (Package 4), Cebu City","REGION VII","QM BUILDERS","PARVANI ABATAYO","SLOPE PROTECTION","NAGA CITY, CEBU","ONGOING","DPWH Region VII",2024,173599993.11,0.8181497087387759,142030783.8,118950781.47,31569209.310000002,0.0,14203078.370000001,45772287.68000001,43799212.07062501,"",null],["24H00046","Convergence and Special Support Program, Basic Infrastruture Program (BIP) - Multi- Purpose Buildings/ Facilities to support Social Services, Construction of Multi-Purpose Building (New Municipal Hall), Poblacion, Dumanjug, Cebu","REGION VII","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","ONGOING","DPWH Region VII",2024,313829992.41,0.5021485283794007,157589268.85,148404316.92374998,156240723.56000003,0.0,15758926.879999999,171999650.44000003,145811300.96062505,"",0.0268],["24H00093","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Manipis-Sinsin Road,Cebu City, Cebu","REGION VII","QM BUILDERS","KEVIN ALVIZO","ROADS","SINSIN, CEBU","ONGOING","DPWH Region VII",2024,67549983.6,0.586413002918923,39612188.73,35709622.120000005,27937794.869999997,0.0,3961218.87,31899013.74,27618487.504999988,"",0.2],["24H00101","Local Program, National Building Program, Buildings And Other Structures \u2013 Multipurpose / Facilities, Construction of Training Facilities and Central Record Depository Building, Phase 2, DPWH Regional Office VII, South Road Properties, Cebu City","REGION VII","QM BUILDERS","KEVIN ALVIZO","BUILDING","SRP, CEBU CITY","ONGOING","DPWH Region VII",2024,36549999.87,0.14999999998632013,5482499.98,5139843.73,31067499.889999997,0.0,0.0,31067499.889999997,29125781.148124997,"",0.7017],["24H00129","Structural Improvement of Public Buildings and Construction of Evacuation Centers - Region VII at Brgy. Cansayahon, Ronda, Cebu","REGION VII","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","RONDA, CEBU","COMPLETED","DPWH Region VII",2024,42556500.0,1.0,42556500.0,36066758.68,0.0,0.0,3829960.07,3829960.07,3829960.0700000003,"",0.8081],["24H00179","Convergence and Special Support Program, Special Road Fund - Motor Vehicle User's Charge (MVUC) as per R.A. 11239, Installation of Solar LED Street Lights and other road safety devices along Cebu South Coastal Road (CSCR), Cebu City, Cebu","REGION VII","QM BUILDERS","KEVIN ALVIZO","STREETLIGHTS","SRP, CEBU CITY","COMPLETED","DPWH Region VII",2025,173699843.72,1.0,173699843.72,162843603.51,0.0,0.0,0.0,0.0,0.0,"",0.8959],["24HE0026","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Asset Preservation Program \u2013 Rehabilitation/Reconstruction of Roads with Slips, Slope Collapse, and Landslide \u2013 Secondary Roads \u2013 Cebu \u2013 Toledo Wharf Rd (Jct Naga-Uling) \u2013 K0023+800 \u2013 K0023+875, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","SLOPE PROTECTION","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,96500000.0,1.0,96500000.0,90468750.0,0.0,0.0,0.0,0.0,0.0,"RET 6/15/26",0.91],["24HE0048","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Network Development Program \u2013 Replacement of Permanent Weak Bridges \u2013 Camp 4 Br. (B00568CB) along Cebu \u2013 Toledo Wharf Rd (Jct Naga-Uling), Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","BRIDGE","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,49000000.0,1.0,49000000.0,45937500.0,0.0,0.0,0.0,0.0,0.0,"RET 7/23/26",0.9173],["24HE0061","Organizational Outcome 1 : Ensure Safe and Reliable National Road System \u2013 Network Development Program \u2013 Construction of By-pass and Diversion Roads \u2013 Cebu-Toledo Wharf Road Linao-Cantabaco Section, Minglanilla, Cebu","CEBU 1ST","QM BUILDERS/ ADAMANT DEVELOPMENT CORPORATION JV","KEVIN ALVIZO","ROADS","MINGLANILLA, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,96500000.0,1.0,96500000.0,90468750.0,0.0,0.0,0.0,0.0,0.0,"RET 7/23/26",0.8017],["24HE0149","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Asset Preservation Program \u2013 Rehabilitation/ Reconstruction of Roads with Slips, Slope Collapse, and Landslide \u2013 Secondary Roads \u2013Cebu \u2013 Toledo Wharf Rd \u2013 K0026+950 \u2013 K0026+1026, Minglanilla, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","SLOPE PROTECTION","MINGLANILLA, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,53557500.0,1.0,53557500.0,50210156.25,0.0,0.0,0.0,0.0,0.0,"RET 6/23/26",1.0],["24HE0163","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) \u2013 Flood Mitigation Structures protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Flood Control Structure along Mananga River (Right Side), Sitio Kimawa, Barangay Jaclupan, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,89100000.0,1.0000000000000002,89100000.00000001,83531250.0,0.0,0.0,0.0,0.0,0.0,"",0.9251],["24HE0167","Convergence and Special Support Program (CSSP) \u2013 Basic Infrastructure Program (BIP) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Revetment Wall Structure along Mananga River (Right Side), Sitio Bogo, Barangay Camp 4, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,148500000.0,1.0,148500000.0,139218750.003304,0.0,0.0,0.0,0.0,0.0,"",1.0],["24HE0177","Convergence and Special Support Program (CSSP) \u2013 Basic Infrastructure Program (BIP) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/ Facilities \u2013 Construction of Road, Camp 6, Campinsa, Brgy. Manipis, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,29700000.0,1.0,29700000.0,27843750.0,0.0,0.0,0.0,0.0,0.0,"",0.9383],["24HE0188","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) - Access Roads and/or Bridges from the National Road/s leading to Major Strategic Public Buildings/Facilities \u2013 Construction of Road, Camp 6, Brgy. Manipis-Junction Linao-Cantabaco Road-Naga Valley Industrial Zone, (Brgy. Lubas, Talisay City, Cebu)","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2024,49480000.0,0.15,7422000.0,6958125.0,42058000.0,0.0,0.0,42058000.0,39429375.0,"",0.0],["24HE0196","Convergence and Special Support Program (CSSP) \u2013 Basic Infrastructure Program (BIP) \u2013 Access Roads and/or Bridges from the National Roads leading to Major/Strategic Public Buildings/Facilities \u2013 Improvement of Maghaway Road, Talisay, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2024,49500000.0,1.0,49500000.0,41951956.024375,0.0,0.0,4454293.98,4454293.98,4454293.975625001,"",0.55],["24HE0218","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/ Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Revetment Wall along Mananga River, Package 2, Sitio Burlas, Barangay Lagtang, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,96481000.0,0.8998842180325659,86821729.24,75572047.46375,9659270.760000005,0.0,5823323.7,15482594.460000005,14878890.036249995,"",0.4749],["24HE0219","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/ Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Flood Control Structure along Mananga River (Left Side) at Purok Tambis, Barangay Jaclupan, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2025,48230000.0,1.0,48230000.0,45215624.989999995,0.0,0.0,0.0,0.0,0.0,"RET 7/23/26",0.9076],["24HE0220","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/ Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Revetment Wall along Mananga River (Left Side) at Sitio Tigib Package 5, Barangay Lagtang, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,48220000.0,0.8936577192036499,43092175.22,37496539.30375,5127824.780000001,0.0,2902374.97,8030199.750000002,7709710.696249999,"",0.4075],["24HE0221","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Revetment Wall along Mananga River (Right Side) at Sitio Quadra, Barangay Lagtang, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,48230000.0,1.0,48230000.0,40875427.628125,0.0,0.0,4340197.37,4340197.37,4340197.371875003,"",0.9467],["24HE0227","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Flood Control Structure, Sitio Cambaye Upper Camp 8, Minglanilla, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","MINGLANILLA, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,96482000.0,0.6040628713127838,58281193.95,54182488.28125,38200806.05,0.0,5828119.4,44028925.449999996,36269386.71875,"",0.5501],["24HE0239","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Building/Facilities \u2013 Construction of Flood Control Structure along Dumlog River (Package 2), Sibonga, Cebu","CEBU 1ST","UNSPECIFIED","GIL AMORIN","FLOOD CONTROL","SIBONGA, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,96480000.0,0.8477235561774461,81788368.7,73046920.93,14691631.299999997,0.0,5833419.41,20525050.709999997,17403079.069999993,"",null],["24HE0240","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Building/Facilities \u2013 Construction of Revetment Wall along Mananga River (Left Side) at Sitio Burlas, Barangay Lagtang, Talisay City, Cebu","CEBU 1ST","UNSPECIFIED","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,96485000.0,0.15,14472750.0,14472750.0,82012250.0,0.0,0.0,82012250.0,75981937.5,"",null],["24HF0010","Convergence and Special Support Program \u2013 Construction of Poblacion, Tampaanan, Esperanza Road in Support to Hermit Cove and Eco Tourism Site in Aloguinsan, Cebu","CEBU 3RD","QM BUILDERS","RAYMOND MANGUILIMOTAN","ROADS","ALOGUINSAN, CEBU","COMPLETED","DPWH Cebu 3rd DEO",2024,38800000.0,1.0,38800000.0,36375000.0,0.0,0.0,0.0,0.0,0.0,"",1.0],["24HF0042","Replacement of Bonbon Br. (B00543CB) along Toledo - Pinamungahan - Aloguinsan - Mantalongon Rd","CEBU 3RD","QM BUILDERS","UNASSIGNED","BRIDGE","PINAMUNGAJAN, CEBU","COMPLETED","DPWH Cebu 3rd DEO",2024,44100000.0,1.0,44100000.0,40214780.3,0.0,0.0,1128969.71,1128969.71,1128969.700000003,"",0.0],["24HF0100","Construction of 4Sty 12CL, Matab-ang ES, Toledo City, Cebu","CEBU 3RD","QM BUILDERS","UNASSIGNED","BUILDING","TOLEDO CITY, CEBU","ONGOING","DPWH Cebu 3rd DEO",2024,35615000.0,0.8983228392531237,31993767.92,28495445.4925,3621232.079999998,0.0,1498711.93,5119944.009999998,4893617.0075,"",null],["24HG0090","Convergence and Special Support Program - Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Flood Mitigation Structures protecting Major/Strategic Public Buildings/ Facilities - Construction of Flood Mitigation Structure along Boljoan River at Brgy. Poblacion (Left Side Downstream), Boljoon, Cebu","CEBU 2ND","QM BUILDERS","JASON CARIN","FLOOD CONTROL","BOLJOON, CEBU","COMPLETED","DPWH Cebu 2ND DEO",2024,139925000.0,1.0,139925000.0,119938878.13250001,0.0,0.0,11240809.370000001,11240809.370000001,11240809.367499992,"",1.0],["24HG0092","Convergence and Special Support Program - Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Flood Mitigation Structures protecting Major/Strategic Public Buildings/Facilities - Construction of Flood Mitigation Structure along Boljoan River at Brgy. Poblacion (Right Side Downstream), Boljoon, Cebu","CEBU 2ND","QM BUILDERS/ QG DEVELOPMENT CORPORATION JV","JASON CARIN","FLOOD CONTROL","BOLJOON, CEBU","COMPLETED","DPWH Cebu 2ND DEO",2024,135100000.0,1.0,135100000.0,115782737.09,0.0,0.0,10873512.91,10873512.91,10873512.909999996,"QMB/QGDC (JV) - QMB IMPLEMENTOR",1.0],["24HK0052","Organizational Outcome 2: Protect Lives and Properties Against Major Floods - Construction/ Rehabiliattion of Flood Mitigation Facilities within Major River Basins and Principal Rivers - Rehabilitation of Tamogong River Control Dike, Bais City, Negros Oriental","NEGROS 2ND","QM BUILDERS","CHARISSA DAGO-OC","FLOOD CONTROL","BAIS CITY, NEGROS ORIENTAL","COMPLETED","DPWH Negros 2nd DEO",2024,115800000.0,1.0,115800000.0,108562500.0025,0.0,0.0,0.0,0.0,0.0,"",1.0],["24HK0106","Organizational Outcome 2: Protect Lives aand Properties Against Major Floods - Flood Management Program - Construction/Maintenance of Flood Mitigation Structures and Drainage Systems - Construction of Tanjay River Control Structure, Tanjay City, Negros Oriental","NEGROS 2ND","QM BUILDERS","UNASSIGNED","FLOOD CONTROL","TANJAY CITY, NEGROS ORIENTAL","COMPLETED","DPWH Negros 2nd DEO",2024,39200000.0,1.0,39200000.0,32830000.0,0.0,0.0,3920000.0,3920000.0,3920000.0,"",1.0],["24HL0041","ORGANIZATIONAL OUTCOME 001: Ensure Safe and Reliable National Road System: Bridge Program: Retrofitting / Strengthening of Permanent Bridges: Sangke Br. (B00046NR) along Dumaguete South Rd","NEGROS 3RD","QM BUILDERS","CHARISSA DAGO-OC","ROADS","BASAY, NEGROS ORIENTAL","COMPLETED","DPWH Negros 3rd DEO",2024,32393900.0,1.0,32393900.0,27075909.95,0.0,0.0,3239390.0,3239390.0,3239390.0,"",0.9826],["24HN0128","CSSP: Basic Infrastructure Program (BIP) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities Construction of Basak-Sugtunggan Bypass Road, Lapu-Lapu City Cebu (Phase 3)","CEBU 6TH","QM BUILDERS","UNASSIGNED","ROADS","LAPU-LAPU CITY, CEBU","ONGOING","DPWH Cebu 6th DEO",2024,98950000.0,0.15,14842500.0,14842500.0,84107500.0,0.0,0.0,84107500.0,77923125.0,"",null],["24HN0141","CSSP: Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities - Construction of Road including Bridge from Sudtunggan to Brgy. Babag, Lapu-Lapu City, Cebu","CEBU 6TH","ADAMANT DEVELOPMENT CORPORATION/ QM BUILDERS JV","GIL AMORIN","ROADS","LAPU-LAPU CITY, CEBU","ONGOING","DPWH Cebu 6th DEO",2024,144700000.0,0.15,21705000.0,21705000.0,122995000.0,0.0,0.0,122995000.0,113951250.0,"",0.1375],["24HN0225","OO1 : Ensure Safe and Reliable National Road System - Network Development Program - Road Widening - Secondary Roads - Mactan Airport Rd - K0018 + (-366) - K0018 + 785","CEBU 6TH","QM BUILDERS","KEVIN ALVIZO","ROADS","LAPU-LAPU CITY, CEBU","SUSPENDED","DPWH Cebu 6th DEO",2025,78005000.0,0.0,0.0,null,78005000.0,0.0,0.0,78005000.0,73129687.5,"",null],["24HO0002","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Dalaguete-Mantalongon-Badian Road, Brgy. Talayong-Brgy. Basak, Badian, Cebu (Package 1)","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,140465222.58,0.6552887021381887,92045273.4,79251214.69912499,48419949.18000001,0.0,7041229.118999999,55461178.29900001,52434931.469625026,"",0.8089],["24HO0003","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Dumanjug By-Pass Road, Brgy. Tangil (Phase II), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,143541009.79,0.5083849487109005,72974088.9,61115799.45487501,70566920.88999999,0.0,7297408.887,77864329.77699998,73453897.22324999,"",0.8128],["24HO0004","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Flood Control Structure, Barangay Kantangkas (Upstream), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,98996461.23,1.0,98996461.23,92809182.408,0.0,0.0,0.0,0.0,0.0,"",1.0],["24HO0015","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Dalaguete-Mantalongon-Badian Road, Brgy. Talayong-Brgy. Basak, Badian, Cebu (Package 2)","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,141663826.87,0.8928165665471268,126479811.51,111480671.265125,15184015.36,0.0,7094152.023,22278167.383,21329166.425500005,"RET COLLECTED 3/13/26",0.9926],["24HO0029","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Secondary Roads, Santander-Barili-Toledo Rd - K0181 + 000 - K0184 + 355","CEBU 7TH","QM BUILDERS","JASON CARIN","ASPHALTING","ALEGRIA & BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,143537167.49,1.0,143537167.49,127368114.82,0.0,0.0,7197979.705,7197979.705,7197979.701875031,"",1.0],["24HO0032","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Bridge Program, Replacement of Permanent Weak Bridges, Tapon Bridge II (B00428CB) along Santander-Barili-Toledo Rd","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","BRIDGE","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,71283500.0,0.15,10692525.0,10024242.180000002,60590975.0,0.0,0.0,60590975.0,56804039.07,"",0.5087],["24HO0033","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Secondary Roads, Santander-Barili-Toledo Rd - K0191 + 175 - K0192 + 674","CEBU 7TH","QM BUILDERS","JASON CARIN","ASPHALTING","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,66341469.96,1.0,66341469.96,57524384.9645,0.0,0.0,4670743.1280000005,4670743.1280000005,4670743.122999996,"",1.0],["24HO0035","ORGANIZATIONAL OUTCOME 2 : Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Looc-Poblacion Seawall, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","UNASSIGNED","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,48239207.23,1.0,48239207.23,45224256.78,0.0,0.0,0.0,0.0,0.0,"",1.0],["24HO0036","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Tertiary Roads, Dalaguete-Mantalongon Badian Rd - K0110 + (-751) - K0110 + 000","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ASPHALTING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,46057726.55,1.0,46057726.55,43179118.641625,0.0,0.0,0.0,0.0,-0.0010000020265579224,"RET 5/26/26",0.9919],["24HO0043","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Bridge Program, Replacement of Bridges (Temporary to Permanent), Manduyong Bridge along Santander-Barili-Toledo Road - K0195 + 198 - K0195 + 220 (PHASE 2)","CEBU 7TH","QM BUILDERS","JASON CARIN","BRIDGE","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,96495405.98,0.8172346655170785,78859390.83,70941870.92,17636015.150000006,0.0,5432135.63,23068150.780000005,19522572.18625,"",0.9006],["24HO0044","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Asset Preservation Program, Rehabilitation/ Reconstruction/ Upgrading of Damaged Paved Roads - Secondary Roads, Santander-Barili-Toledo Rd - K0217 + 358 - K0217 + 850, K0217 + 870 - K0218 + 000","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,82018754.34,0.9999999999999998,82018754.33999999,76892582.21,0.0,0.0,0.0,0.0,-0.01624998450279236,"RET 5/26/26",0.97],["24HO0045","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Tertiary Roads, Sibonga-Dumanjug Rd - K0068 + 137 - K0069 + 000, K0072 + 266 - K0072 + 975","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ASPHALTING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,65681400.0,1.0,65681400.0,61576312.50000001,0.0,0.0,0.0,0.0,0.0,"RET 5/28/26",0.965],["24HO0052","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Bridge Program, Rehabilitation / Major Repair of Bridge, Alegria Bridge (B00463CB) along Santander-Barili-Toledo Road","CEBU 7TH","QM BUILDERS","JASON CARIN","BRIDGE","ALEGRIA, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,31356866.5,0.14774754358826,4632900.0,4343343.75,26723966.5,0.0,0.0,26723966.5,25053718.59375,"",0.65],["24HO0060","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Secondary Roads, Santander-Barili-Toledo Rd - K0195 + 220 - K0195 + 327, K0196 + 1108 - K0197 + 786, K0200 + 162 - K0201 + 148","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,96493385.24,1.0,96493385.24,80813210.14,0.0,0.0,9649338.524,9649338.524,9649338.522499993,"",1.0],["24HO0067","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Patong - Basak Road (Patong Section), Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,57894457.53,1.0,57894457.53,51080288.66,0.0,0.0,3195765.272,3195765.272,3195765.2743750066,"",1.0],["24HO0069","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Interjurisdictional Roads and/or Bridges (or, roads that traverse multiple LGU jurisdictions), Construction of Road, Package 2, Barangay Tangil, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","SUSPENDED","DPWH Cebu 7th DEO",2024,57028900.0,0.15,8554335.0,8019689.062500001,48474565.0,0.0,0.0,48474565.0,45444904.6875,"",0.38],["24HO0072","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Secondary Roads, Santander-Barili-Toledo Rd - K0154 + 064 - K0155 + 070","CEBU 7TH","QM BUILDERS","JASON CARIN","ASPHALTING","GINATILAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,48997799.8,1.0,48997799.8,45935437.31,0.0,0.0,0.0,0.0,0.002499997615814209,"RET 5/28/26",1.0],["24HO0078","LOCAL PROGRAM, National Building Program, Buildings and Other Structures - Multipurpose/ Facilities, Construction of Annex Building (Quality Assurance Laboratory, Maintenance and Supply Office), Phase 2, DPWH - Cebu 7th District Engineering Office, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,77199631.52,0.8976276118888915,69296520.88,59498322.32,7903110.640000001,0.0,5467166.01,13370276.65,12876332.229999997,"",0.987],["24HO0079","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall along Lanao River (Upstream), Moalboal, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","FLOOD CONTROL","MOALBOAL, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,57896445.7,1.0,57896445.7,54277917.845625,0.0,0.0,0.0,0.0,0.0,"RET COLLECTED 3/13/26",1.0],["24HO0085","LOCAL PROGRAM, National Building Program, Buildings and Other Structures - Multipurpose /Facilities, Construction of Motorpool Building and Bayshop Phase 2, DPWH - Cebu 7th District Engineering Office, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,28957000.0,0.0,0.0,null,28957000.0,0.0,0.0,28957000.0,27147187.5,"",0.7674],["24HO0086","LOCAL PROGRAM, National Building Program, Buildings And Other Structures - Multipurpose / Facilities, Construction of DPWH-Cebu 7th Power House Building, Phase 2, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,9651000.0,1.0,9651000.0,8082712.5,0.0,0.0,965100.0,965100.0,965100.0,"",0.9651],["24HO0097","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Kanghalo Road, Package 1, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,48988908.17,1.0,48988908.17,41028210.582499996,0.0,0.0,4898890.82,4898890.82,4898890.826875009,"",1.0],["24HO0098","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Talayong Bridge, Phase 2, Barangay Talayong, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","BRIDGE","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,48998052.37,1.0,48998052.37,43438288.11,0.0,0.0,2497385.98,2497385.98,2497385.9868749976,"",1.0],["24HO0103","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Kantangkas Bridge, Phase 2, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","BRIDGE","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,95050000.0,0.2998200734350342,28497897.98,33226147.2057143,66552102.019999996,0.0,2849789.8,69401891.82,55883227.7942857,"",0.4905],["24HO0110","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction (Completion) of Kanghalo Bridge, Kanghalo, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,48262000.0,1.0,48262000.0,45245625.0,0.0,0.0,0.0,0.0,0.0,"RET 3/30/26",1.0],["24HO0114","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","COMPLETED","DPWH Cebu 7th DEO",0,85541000.0,1.0,85541000.0,71640587.5,0.0,0.0,8554100.0,8554100.0,8554100.0,"",null],["24HO0115","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Network Development Program, Road Widening - Secondary Roads, Santander-Barili-Toledo Rd - K0179 + 796 - K0179 + 885","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","ALEGRIA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,72368676.09,1.0,72368676.09,67845633.83,0.0,0.0,0.0,0.0,0.0,"RET 3/30/26",1.0],["24HO0118","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall at Polo River (Purok Kasagingan - Purok Kabalasan), Barangay Polo, Alcantara, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","FLOOD CONTROL","ALCANTARA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,57896955.79,1.0,57896955.79,54278396.05,0.0,0.0,0.0,0.0,0.003125004470348358,"RET 4/30/26",0.9894],["24HO0125","ORGANIZATIONAL OUTCOME 2 : Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Revetment Wall at Sitio Gisi, Barangay Sorsogon, Malabuyoc, Cebu (Left Side)","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","MALABUYOC, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,128176913.49,1.0000000000000002,128176913.49000001,120165856.4,0.0,0.0,0.0,0.0,0.0,"RET 3/30/26",1.0],["24HO0126","LOCAL PROGRAM, National Building Program, Buildings And Other Structures - Multipurpose / Facilities, Construction (Completion) of DPWH Cebu 7th DEO, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2024,52634000.0,0.36733502621879394,19334311.77,16192486.16,33299688.23,null,1933431.12,35233119.35,33151888.84,"",0.8],["24HO0127","LOCAL PROGRAM, National Building Program - Buildings And Other Structures - Multipurpose / Facilities, Construction of DPWH Building (Phase II) of DPWH Cebu 7th DEO, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,48249904.05,1.0,48249904.05,41895414.17,0.0,0.0,3338870.88,3338870.88,3338870.876874998,"",0.9583],["24HO0128","LOCAL PROGRAM, National Building Program, Buildings And Other Structures - Multipurpose / Facilities, Construction of Employees Quarters, DPWH Cebu 7th DEO, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,29398058.88,1.0,29398058.88,27560680.2028571,null,null,0.0,0.0,-0.0028571002185344696,"RET 5/26/26",0.9893],["24HO0137","Concreting of Brgy. Masa FMR, Brgy. Masa, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2024,49733625.52,1.0,49733625.52,46625273.92,0.0,0.0,0.0,0.0,0.0,"RET.5/26/26",1.0],["24HO0150","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction (Road Opening) of Brgy. Manlapay - Brgy. Matalao Road, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,142577000.0,0.7034802240193019,100300099.9,84001333.66,42276900.099999994,0.0,10030009.99,52306910.089999996,49664603.84,"",0.7328],["24HO0153","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall at Barangay Matalao (Upstream), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,95048500.0,1.0,95048500.0,89107968.75000001,0.0,0.0,0.0,0.0,0.0,"RET 6/4/26",1.0],["24HO0154","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction (Road Opening) of Brgy. Colabtingon-Matalao-Manlapay Road, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95051000.0,0.8516879457343951,80953790.92999999,67798799.91,14097209.070000008,0.0,8095379.09,22192588.160000008,21311512.590000004,"",0.9646],["24HO0163","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Special Road Fund - Motor Vehicle User's Charge (MVUC) as per R.A. 11239, Installation of Roadway Lighting along Santander-Barili-Toledo Rd, Barangay Monta\u00f1eza, Mabuyoc, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","STREETLIGHTS","MALABUYOC, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,142579000.0,0.8991328696371835,128197465.41999999,113054798.94,14381534.580000013,0.0,7130324.89,21511859.470000014,20613013.560000002,"",0.9608],["24HO0169","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Bank Protection Structures at Sitio Lalao, Barangay Canduling, Ronda, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","FLOOD CONTROL","RONDA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,95052000.0,1.0,95052000.0,89111250.0,0.0,0.0,0.0,0.0,0.0,"RET 4/30/26",0.9945],["24HO0170","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Special Road Fund - Motor Vehicle User's Charge (MVUC) as per R.A. 11239, Installation of Roadway Lighting along Santander-Barili- Toledo Rd, Barangay Malabago - Barangay Hinablan, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","STREETLIGHTS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052500.0,0.8991462661160937,85466100.46,75348176.63,9586399.540000007,0.0,4776292.56,14362692.100000005,13763542.120000005,"",0.9982],["24HO0171","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Special Road Fund - Motor Vehicle User's Charge (MVUC) as per R.A. 11239, Installation of Roadway Lighting along Santander-Barili-Toledo Rd, Barangay Malhiao - Barangay Bugas, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","STREETLIGHTS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052000.0,0.8905579743719227,84649316.58,74585263.64000002,10402683.420000002,0.0,4773470.66,15176154.080000002,14525986.359999985,"",0.7945],["24HO0172","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Special Road Fund - Motor Vehicle User's Charge (MVUC) as per R.A. 11239, Installation of Roadway Lighting along Santander-Barili-Toledo Rd, Barangay Poblacion- Barangay Santa Filomena, Alegria, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","STREETLIGHTS","ALEGRIA, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052500.0,0.8906711800320876,84660522.34,73619891.596,10391977.659999996,0.0,5749348.104,16141325.763999997,15491827.154,"",0.7882],["24HO0173","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Special Road Fund - Motor Vehicle User's Charge (MVUC) as per R.A. 11239, Installation of Roadway Lighting along Santander-Barili-Toledo Rd, Barangay Ylaya - Barangay Tapon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","STREETLIGHTS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,47526000.0,0.8909164524681227,42341695.32,37316490.32000001,5184304.68,0.0,2378849.04,7563153.72,7239134.679999992,"",0.6505],["24HO0176","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall at Barangay Kantangkas - Kang-actol, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052000.0,0.0,0.0,null,95052000.0,0.0,0.0,95052000.0,89111250.0,"",0.32],["24HO0177","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall at Barangay Colabtingon - Barangay Kang-Actol, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052000.0,0.0,0.0,null,95052000.0,0.0,0.0,95052000.0,89111250.0,"",0.2425],["24HO0179","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Network Development Program, Road Widening - Secondary Roads, Santander-Barili-Toledo Rd - K0201 + 300 - K0201 + 570","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","ROADS","MOALBOAL, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,23622500.0,0.0,0.0,null,23622500.0,0.0,0.0,23622500.0,22146093.75,"",0.3727],["24I00057","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","ONGOING","DPWH REGION VIII",0,217566524.19,0.6501252539038413,141445491.78,118460599.36,76121032.41,0.0,14144549.18,90265581.59,85508017.068125,"",null],["25H00011","ORGANIZATIONAL OUTCOME 2: Protect Lives and Properties Against Major Floods, Flood Management Program, Construction/ Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers, Construction of Flood Mitigation Structure, Sapangdaku River, Barangay Ilihan, Toledo City, Cebu","REGION VII","QM BUILDERS","RAYMOND MANGUILIMOTAN","FLOOD CONTROL","TOLEDO CITY, CEBU","ONGOING","DPWH Region VII",2025,115699999.99,0.7161878399063256,82862933.07,71898635.08125,32837066.92,0.0,5785364.68,38622431.6,36570114.909375,"",0.4049],["25H00039","Local Program, National Building Program, Buildings And Other Structures, Construction of Employees Quarters, DPWH Regional Office VII, Phase III, South Road Properties, Cebu, City","REGION VII","QM BUILDERS","KEVIN ALVIZO","BUILDING","SRP, CEBU CITY","COMPLETED","DPWH Region VII",2025,7014500.0,0.0,0.0,null,7014500.0,0.0,0.0,7014500.0,6576093.75,"",1.0],["25H00073","Organizational Outcome 1: Ensure Safe and Reliable National Road System, Network Development Program - Construction of By- Pass and Diversion Roads, Metro Cebu Expressway, Package 5, Cebu","REGION VII","QM BUILDERS","PARVANI ABATAYO","FLOOD CONTROL","NAGA CITY, CEBU","ONGOING","DPWH Region VII",2025,96489560.2,0.405290320206061,39106284.75,32751513.49,57383275.45,0.0,3910628.47,61293903.92,57707449.197500005,"",0.0],["25H00098","Organizational Outcome 1: Ensure Safe and Reliable National Road System, Asset Preservation Program - Preventive Maintenance - Secondary Roads, Cebu Toledo Wharf RD (JCT Naga-Uling) - K0011 + 240 - K0013 + 075, K0013 + 240 - K0014 + 730, K0016 + 630 - K0016 + 1644, K0016 + 2043 - K0023 + 500, K0024 + 000 - K0024 + 500","REGION VII","QM BUILDERS","RAYMOND MANGUILIMOTAN","ASPHALTING","CEBU PROVINCE","ONGOING","DPWH Region VII",2025,141855000.0,0.15,21278250.0,21278250.0,120576750.0,0.0,0.0,120576750.0,111710812.5,"",0.15],["25H00114","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Libo - Barangay Guibangco-an, Sibonga, Cebu Phase 1","REGION VII","QM BUILDERS","RAYMOND MANGUILIMOTAN","ROADS","SIBONGA, CEBU","SUSPENDED","DPWH Region VII",2025,283708999.95,0.14999999999118815,42556349.99,42556349.99,241152649.95999998,0.0,0.0,241152649.95999998,223420837.463125,"",0.0],["25H00115","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Libo - Barangay Guibangco-an, Sibonga, Cebu Phase 2","REGION VII","QM BUILDERS","RAYMOND MANGUILIMOTAN","ROADS","SIBONGA, CEBU","ONGOING","DPWH Region VII",2025,283709499.94,0.1499999999964753,42556424.99,42556424.99,241153074.95,0.0,0.0,241153074.95,223421231.20374998,"",0.0],["25H00116","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Tubod-Duguan - Barangay Pangpang, Barili, Cebu Phase 1","REGION VII","QM BUILDERS","GERISZA CARLA ENERO","ROADS","BARILI, CEBU","ONGOING","DPWH Region VII",2025,283708499.93,0.14999999996651492,42556274.98,42556274.98,241152224.95000002,0.0,0.0,241152224.95000002,223420443.70437503,"",0.0],["25H00117","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Tubod-Duguan - Barangay Pangpang, Barili, Cebu Phase 2","REGION VII","QM BUILDERS","GERISZA CARLA ENERO","ROADS","BARILI, CEBU","ONGOING","DPWH Region VII",2025,283707999.92,0.14999999997180197,42556199.98,42556199.98,241151799.94000003,0.0,0.0,241151799.94000003,223420049.94500002,"",0.0],["25H00119","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Manlapay - Barangay Doldol, Dumanjug, Cebu Phase 2","REGION VII","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Region VII",2025,283707000.0,0.44997017225517877,127659687.66,106914988.4375,156047312.34,0.0,12765968.75,168813281.09,159060324.0625,"",0.1],["25H00120","Convergence and Special Support Program, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Matalao - Barangay Manlapay, Dumanjug, Cebu","REGION VII","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Region VII",2025,359365999.9,0.3772401932506804,135567299.25,113537613.13187501,223798700.64999998,0.0,13556729.92,237355430.56999996,223368011.774375,"",0.1],["25H00141","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","ONGOING","DPWH Region VII",0,21546423.8,0.4906,10571182.65,8853365.47,10975241.15,0.0,1057118.26,12032359.41,11346406.8425,"",null],["25HD0014","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System \u2013 Network Development Program \u2013 Construction of By-Pass and Diversion Roads \u2013 Carcar Bypass Road, Carcar, Cebu","CEBU 1ST","QM BUILDERS","GIL AMORIN","ROADS","CARCAR CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,96480000.0,0.683778070791874,65970908.27,60172879.073125005,30509091.729999997,0.0,6597090.83,37106182.559999995,30277120.926874995,"",0.4457],["25HD0055","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Asset Preservation Program \u2013 Rehabilitation/Reconstruction/Upgrading of Damaged Paved Roads \u2013 Secondary Roads \u2013 Cebu-Toledo Wharf Rd (Jct. Naga \u2013 Uling) \u2013 K0011+028 \u2013 K0011+240, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2025,9640000.0,1.0,9640000.0,9037500.0,0.0,0.0,0.0,0.0,0.0,"",1.0],["25HD0057","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Maintenance of Flood Mitigation Structures and Drainage Systems \u2013 Construction of Flood Mitigation Structure, Naga River, Barangay Mainit, Naga, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","FLOOD CONTROL","NAGA CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,96480000.0,0.5010664027777778,48342886.54,47707734.501250006,48137113.46,0.0,4834288.65,52971402.11,42742265.498749994,"",0.3896],["25HD0077","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program - Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems \u2013 Construction of Flood Mitigation Structure, Naga River, Barangay Lutac, Naga, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","FLOOD CONTROL","NAGA CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,96480000.0,0.5042778311567164,48652725.15,47920748.53812499,47827274.85,0.0,4865272.52,52692547.370000005,42529251.46187501,"",0.6228],["25HD0107","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Revetment Wall along Mananga River (Downstream), Right Side, Purok Nangka, Barangay Camp 4, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,142753000.0,0.15,21412950.0,21412950.0,121340050.0,0.0,0.0,121340050.0,112417987.5,"",0.1713],["25HD0112","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Revetment Wall along Mananga River (Downstream), Left Side, Purok Nangka, Barangay Camp 4, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,142755000.0,0.15,21413250.0,21413250.0,121341750.0,0.0,0.0,121341750.0,112419562.5,"",0.2445],["25HD0114","Convergence and Special Support Program (CSSP) - Basic Infrastructure Program (BIP) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Package 3, Barangay Manipis \u2013 Junction Linao \u2013 Cantabaco Road \u2013 Naga Valley Industrial Zon, Barangay Camp 6, City of Talisay, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,59375000.0,0.15,8906250.0,8906250.0,50468750.0,0.0,0.0,50468750.0,46757812.5,"",null],["25HD0125","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/ Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Flood Control Structure along Mananga River (Right Side) at Sitio Cambawog (Upper), Barangay Camp 4, Talisay City, Cebu (Package 2)","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,96480000.0,0.15,14472000.0,14472000.0,82008000.0,0.0,0.0,82008000.0,75978000.0,"",0.1728],["25HD0130","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Asset Preservation Program \u2013 Rehabilitation/Reconstruction of Roads with Slips, Slope Collapse, and Landslide \u2013 Secondary Roads -Cebu-Toledo Wharf Rd (Jct Naga-Uling) \u2013 K0026+1026 \u2013 K0027+000, Minglanilla, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","FLOOD CONTROL","MINGLANILLA, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,24115000.0,0.8990342334646485,21680210.54,19484636.560000002,2434789.460000001,0.0,1205779.25,3640568.710000001,3123175.9399999976,"",0.9358],["25HD0132","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Bridge Program \u2013 Widening of Permanent Bridges \u2013 Dumlog Br. (B00654CB) along N Bacalso Ave (Cebu South Rd) (Phase II), Sibonga, Cebu","CEBU 1ST","QM BUILDERS","GIL AMORIN","BRIDGE","SIBONGA, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2025,24120000.0,1.0,24120000.0,19920864.04,0.0,0.0,2163434.7,2163434.7,2691635.960000001,"",0.706],["25HD0133","Organizational Outcome 1: Ensure Safe and Reliable National Road System \u2013 Bridge Program \u2013 Widening of Permanent Bridges \u2013 Sta. Filomena Br. (B00045CB) along N Bacalso Ave (Cebu South Rd) (Phase II), Sibonga, Cebu","CEBU 1ST","QM BUILDERS","GIL AMORIN","BRIDGE","SIBONGA, CEBU","COMPLETED","DPWH Cebu 1ST DEO",2025,24110000.0,1.0,24110000.0,22603125.001875,0.0,0.0,0.0,0.0,0.0,"RET 5/20/26",0.9025],["25HD0134","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/ Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Flood Control along Mananga River (Upstream), Left Side, Package 1, Sitio Proper, Barangay Camp IV, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,144730000.0,0.15,21709500.0,21709500.0,123020500.0,0.0,0.0,123020500.0,113974875.0,"",0.2888],["25HD0135","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Revetment Wall along Mananga River, Right Side, Package 1, Sitio Crossing, Barangay Camp IV, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,72355000.0,0.15,10853250.0,10853250.0,61501750.0,0.0,0.0,61501750.0,56979562.5,"",0.422],["25HD0136","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Rehabilitation of Flood Mitigation Facilities within Major River Basins and Principal Rivers \u2013 Construction of Flood Control Structure along Mananga River (Right Side) at Sitio Bahala, Barangay Lagtang, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,96480000.0,0.15,14472000.0,14472000.0,82008000.0,0.0,0.0,82008000.0,75978000.0,"",0.8067],["25HD0137","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Package 2, Barangay Manipis \u2013 Junction Linao \u2013 Cantabaco Road \u2013 Naga Valley Industrial Zone, Barangay Camp 6, City of Talisay, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,98980000.0,0.15,14847000.0,14847000.0,84133000.0,0.0,0.0,84133000.0,77946750.0,"",null],["25HD0146","Organizational Outcome 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/Maintenance of Flood Mitigation Structures and Drainage Systems - Construction of Flood Control along Mananga River (Right Side) at Sitio Kawatan, Barangay Tabunok, Talisay City, Cebu","CEBU 1ST","QM BUILDERS/ ADAMANT DEVELOPMENT CORPORATION JV","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,144731000.0,0.15,21709650.0,21709650.0,123021350.0,0.0,0.0,123021350.0,113975662.5,"",0.0355],["25HD0168","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Oca\u00f1a to Barangay Abugon, Carcar City, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","ROADS","CARCAR CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,141850000.0,0.15,21277500.0,21277500.0,120572500.0,0.0,0.0,120572500.0,111706875.0,"",null],["25HD0169","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Abugon to Barangay Oca\u00f1a, Carcar City, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","ROADS","CARCAR CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,141853000.0,0.15,21277950.0,21277950.0,120575050.0,0.0,0.0,120575050.0,111709237.5,"",null],["25HD0170","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Revetment Wall along Mananga River (Right Side), Sitio Tinubdan, Barangay Jaclupan, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,106710000.0,0.5884280846218723,62791160.91,59175423.12,43918839.09,0.0,6279116.09,50197955.18000001,40865201.88,"",0.7],["25HD0171","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Revetment Wall along Mananga River (Right Side) at Sitio Burias, Barangay Lagtang, Talisay City, Cebu (Package II)","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,97020000.0,0.15,14553000.0,14553000.0,82467000.0,0.0,0.0,82467000.0,76403250.0,"",0.1591],["25HD0177","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Manipis \u2013 Junction Linao - Cantabaco Road \u2013 Naga Valley Industrial Zone, Package 4, Barangay Camp 6, City of Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,94570000.0,0.15,14185500.0,14185500.0,80384500.0,0.0,0.0,80384500.0,74473875.0,"",null],["25HD0178","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Guibangco-an to Barangay Abugon, Sibonga, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","ROADS","SIBONGA, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,141855000.0,0.15,21278250.0,21278250.0,120576750.0,0.0,0.0,120576750.0,111710812.5,"",null],["25HD0179","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Abugon to Barangay Guibangco-an, Sibonga, Cebu","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","ROADS","SIBONGA, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,141854000.0,0.15,21278100.0,21278100.0,120575900.0,0.0,0.0,120575900.0,111710025.0,"",null],["25HD0180","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Guibangco-an - Barangay Abugon, Sibonga, Cebu Phase 1","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","ROADS","SIBONGA, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,141853500.0,0.15,21278025.0,21278025.0,120575475.0,0.0,0.0,120575475.0,111709631.25,"",null],["25HD0181","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Road, Barangay Guibangco-an - Barangay Abugon, Sibonga, Cebu Phase 2","CEBU 1ST","QM BUILDERS","PARVANI ABATAYO","ROADS","SIBONGA, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,141854500.0,0.15,21278175.0,21278175.0,120576325.0,0.0,0.0,120576325.0,111710418.75,"",null],["25HD0182","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Revetment Wall along Mananga River (Left Side), Sitio Tinubdan, Barangay Jaclupan, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,140679000.0,0.5766891084667932,81128047.09,76877382.37,59550952.91,0.0,8112804.71,67663757.61999999,55009180.129999995,"",0.1708],["25HD0183","Convergence and Special Support Program \u2013 Basic Infrastructure Program (BIP) \u2013 Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities \u2013 Construction of Revetment Wall along Mananga River (Right Side), Purok Tambis, Barangay Jaclupan, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","FLOOD CONTROL","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,140678000.0,0.15,21101700.0,21101700.0,119576300.0,0.0,0.0,119576300.0,110783925.0,"",0.1717],["25HD0186","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of By-pass and Diversion Road, Cebu-Toledo Wharf Road Linao Cantabaco Section, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","MINGLANILLA, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,94570000.0,0.3557183382679497,33640283.25,37313194.730000004,60929716.75,0.0,3364028.33,64293745.08,51346180.269999996,"",0.05],["25HD0187","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Manggilamon \u2013 Tapul Road, Talisay City, Cebu","CEBU 1ST","QM BUILDERS","KEVIN ALVIZO","ROADS","TALISAY CITY, CEBU","SUSPENDED","DPWH Cebu 1ST DEO",2025,94569000.0,0.15,14185350.0,14185350.0,80383650.0,0.0,0.0,80383650.0,74473087.5,"",0.0],["25HD0188","Convergence and Special Support Program - Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) - Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities - Construction of Manggilamon Bridge, Talisay City, Cebu","CEBU 1ST","QM BUILDERS/ ADAMANT DEVELOPMENT CORPORATION JV","KEVIN ALVIZO","BRIDGE","TALISAY CITY, CEBU","ONGOING","DPWH Cebu 1ST DEO",2025,141855000.0,0.15,21278250.0,21278250.0,120576750.0,0.0,0.0,120576750.0,111710812.5,"",null],["25HE0015","ORGANIZATIONAL OUTCOME 2: Protect Lives and Properties Against Major Floods \u2013 Flood Management Program \u2013 Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems \u2013 Construction of Flood Control Structure, Sumaguan River, Barangay Sumaguan, Argao, Cebu","CEBU 2ND","QM BUILDERS","PARVANI ABATAYO","FLOOD CONTROL","ARGAO, CEBU","COMPLETED","DPWH Cebu 2ND DEO",2025,96400000.0,1.0,96400000.0,81797454.72375,0.0,0.0,8577545.28,8577545.28,8577545.276250005,"",0.9821],["25HE0078","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Coastal Roads/Causeway for environmental protection/conservation \u2013 Construction of Flood Control Structure, Sitio Cambangyao, Barangay Poblacion, Dalaguete, Cebu","CEBU 2ND","QM BUILDERS","JASON CARIN","FLOOD CONTROL","DALAGUETE, CEBU","COMPLETED","DPWH Cebu 2ND DEO",2025,94570000.0,1.0,94570000.0,83840101.54,0.0,0.0,4819273.46,4819273.46,4819273.459999993,"",0.2143],["25HE0084","Convergence and Special Support Program \u2013 Sustainable Infrastructure Projects Alleviating Gaps (SIPAG) \u2013 Access Roads and/or Bridges from the National Road/s leading to Major/Strategic Public Buildings/Facilities \u2013 Construction of Casay Airstrip-Tuba-Lumbang leading to Enchanted Mountain Resort, Dalaguete, Cebu","CEBU 2ND","QM BUILDERS","JASON CARIN","ROADS","DALAGUETE, CEBU","SUSPENDED","DPWH Cebu 2ND DEO",2025,38416000.0,0.0,0.0,null,38416000.0,0.0,0.0,38416000.0,36015000.0,"",null],["25HE0099","Concreting of Brgy. Gawi to Brgy. Kanangkaan FMR, Brgy. Gawi and Brgy. Kanangkaan, Oslob, Cebu","CEBU 2ND","QM BUILDERS","JASON CARIN","ROADS","OSLOB, CEBU","ONGOING","DPWH Cebu 2ND DEO",2025,29253000.0,0.8918923597579735,26090527.2,22286857.12,3162472.8000000007,0.0,2173012.13,5335484.930000001,5137830.379999999,"",0.7429],["25HK0065","Organizational Outcome 1: Ensure safe and reliable national road system- network development program - Construction of Bypass and diversion road, Bais Bypass Road, Bais","NEGROS 2ND","QM BUILDERS","CHARISSA DAGO-OC","ROADS","BAIS CITY, NEGROS ORIENTAL","COMPLETED","DPWH Negros 2nd DEO",2025,62088000.0,1.0,62088000.0,58207499.996249996,0.0,0.0,0.0,0.0,0.0037500038743019104,"RET 6/11/26",0.9],["25HO0005","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructures protecting Major/Strategic Public Buildings/Facilities , Construction of Revetment Wall (Upstream Left Side) at Sitio Poblacion, Barangay Madridejos, Alegria, Cebu","CEBU 7TH","QM BUILDERS","UNASSIGNED","FLOOD CONTROL","ALEGRIA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,71000950.0,1.0,71000950.0,66563390.621874996,0.0,0.0,0.0,0.0,0.0,"RET 3/13/26",null],["25HO0006","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall (Upstream Right Side) at Sitio Poblacion, Barangay Madridejos, Alegria, Cebu","CEBU 7TH","QM BUILDERS","UNASSIGNED","FLOOD CONTROL","ALEGRIA, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,71300656.24,1.0,71300656.24,66844365.220625,0.0,0.0,null,0.0,0.0,"RET. 3/25/26",null],["25HO0018","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Sulsugan Matutinao Road, Barangay Sulsugan and Matutinao, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,14627000.0,1.0,14627000.0,12250112.5,0.0,0.0,1462700.0,1462700.0,1462700.0,"",1.0],["25HO0035","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Public Infrastructures/ Facilities, Construction of Revetment (Upstream), Barangay Paculob, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052000.0,0.8854379728990448,84162650.2,74135798.97,10889349.799999997,0.0,4766685.6,15656035.399999997,14975451.030000001,"",0.8995],["25HO0037","ORGANIZATIONAL OUTCOME 2: PROTECT LIVES AND PROPERTIES AGAINST MAJOR FLOODS, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Revetment Wall at Sitio Parale (Downstream), Barangay Sorsogon, Malabuyoc, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","MALABUYOC, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48262000.0,0.5976361727653225,28843116.97,24156110.46,19418883.03,0.0,2884311.7,22303194.73,21089514.54,"",0.5253],["25HO0046","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Public Infrastructures/ Facilities, Construction of Revetment Wall at Barangay Colabtingon (Downstream Left Side), Dumanjug , Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,95052000.0,1.0,95052000.0,82400379.7,0.0,0.0,6710870.29,6710870.29,6710870.299999997,"",0.8455],["25HO0048","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Public Infrastructures/ Facilities, Construction of Revetment Wall, Package 2, Barangay Balaygtiki (Downstream), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,95051500.0,1.0,95051500.0,82498394.72,0.0,0.0,6612386.516,6612386.516,6612386.530000001,"",0.9958],["25HO0051","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Multi- Purpose Buildings/ Facilities to Support Social Services, Construction (Completion) of Multi-Purpose Building, Barangay Kambanog, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,1950200.0,1.0,1950200.0,1633292.5,0.0,0.0,195020.0,195020.0,195020.0,"",1.0],["25HO0053","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Multi-Purpose Buildings/ Facilities to Support Social Services, Construction (Completion) of Multi-Purpose Building, Barangay Manlapay, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,1950000.0,1.0,1950000.0,1633125.0,0.0,0.0,195000.0,195000.0,195000.0,"",1.0],["25HO0054","ORGANIZATIONAL OUTCOME 2: PROTECT LIVES AND PROPERTIES AGAINST MAJOR FLOODS, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Seawall, Kalubihan, Barangay Guiwanon, Ginatilan, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","GINATILAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052000.0,0.0,0.0,null,95052000.0,0.0,0.0,95052000.0,89111250.0,"",0.8855],["25HO0055","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Tubod Bitoon - Barangay Kanyuko, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052500.0,0.15,14257875.0,14257875.0,80794625.0,0.0,0.0,80794625.0,74853843.75,"",0.1],["25HO0063","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Multi-Purpose Buildings/ Facilities to Support Social Services, Construction (Completion) of Multi-Purpose Building, Barangay Kabalaasnan, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,1950000.0,1.0,1950000.0,1729609.2999999998,0.0,0.0,98516.1,98516.1,98515.70000000019,"",1.0],["25HO0066","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Kanyuko - Barangay Tubod Bitoon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052500.0,0.3010052051234844,28611297.26,23961961.450000003,66441202.739999995,0.0,2861129.73,69302332.47,65149757.3,"",0.15],["25HO0069","ORGANIZATIONAL OUTCOME 2: PROTECT LIVES AND PROPERTIES AGAINST MAJOR FLOODS, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Drainage System, Barangay Tapon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","UNASSIGNED","FLOOD CONTROL","DUMANJUG, CEBU","SUSPENDED","DPWH Cebu 7th DEO",2025,48264000.0,0.0,0.0,null,48264000.0,0.0,0.0,48264000.0,45247500.0,"",null],["25HO0074","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Multi-Purpose Buildings/ Facilities to Support Social Services, Construction (Completion) of Multi-Purpose Building, Barangay Kanguha, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,1950000.0,1.0,1950000.0,1729828.1600000001,0.0,0.0,98296.84,98296.84,98296.83999999985,"",1.0],["25HO0076","ORGANIZATIONAL OUTCOME 2: PROTECT LIVES AND PROPERTIES AGAINST MAJOR FLOODS, Flood Management Program, Construction/ Maintenance of Flood Mitigation Structures and Drainage Systems, Construction of Flood Control Structure (Upstream), Barangay Paculob, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,95052000.0,0.5061580845221563,48111338.25,40293245.78,46940661.75,0.0,4811133.83,51751795.58,48818004.22,"",0.2557],["25HO0077","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Access Roads and/or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities, Construction of Parale Bridge, Barangay Sorsogon, Malabuyoc, Cebu","CEBU 7TH","QM BUILDERS","UNASSIGNED","BRIDGE","MALABUYOC, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,97514000.0,0.31170685686157884,30395782.44,25456467.7975,67118217.56,0.0,3039578.24,70157795.8,65962907.2025,"",null],["25HO0079","LOCAL PROGRAM, Buildings and Other Structures - Multipurpose / Facilities, National Building Program, Construction of DPWH Cebu 7th DEO Property Wall, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,28959000.0,0.5070240505542318,14682909.48,12296936.681250002,14276090.52,0.0,1468290.95,15744381.469999999,14852125.818749998,"",0.6],["25HO0081","LOCAL PROGRAM, Buildings and Other Structures - Multipurpose / Facilities, National Building Program, Construction of Employees Quarters and Integrated Multi-Purpose Building, DPWH Cebu 7th DEO, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,19306000.0,1.0,19306000.0,18099374.99625,0.0,0.0,0.0,0.0,0.003750000149011612,"RET 5/28/26",1.0],["25HO0084","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Multi- Purpose Buildings/ Facilities to Support Social Services, Construction (Completion) of Multi-Purpose Building, Barangay Bitoon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","COMPLETED","DPWH Cebu 7th DEO",2025,1950200.0,0.0,0.0,null,1950200.0,0.0,0.0,1950200.0,1828312.5,"",1.0],["25HO0086","ORGANIZATIONAL OUTCOME 1: ENSURE SAFE AND RELIABLE NATIONAL ROAD SYSTEM, Network Development Program, Road Widening - Secondary Roads, Santander-Barili-Toledo Rd - K0213 + 353 - K0214 + 884","CEBU 7TH","QM BUILDERS/ QG DEVELOPMENT CORPORATION JV","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,127155000.0,0.0,0.0,null,127155000.0,0.0,0.0,127155000.0,119207812.5,"",0.0017],["25HO0087","ORGANIZATIONAL OUTCOME 1: ENSURE SAFE AND RELIABLE NATIONAL ROAD SYSTEM, Bridge Program, Replacement of Permanent Weak Bridges, Manduyong Br. (B00443CB) along Santander-Barili-Toledo Rd","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48264000.0,0.0,0.0,null,48264000.0,0.0,0.0,48264000.0,45247500.0,"",0.2698],["25HO0090","ORGANIZATIONAL OUTCOME 1: ENSURE SAFE AND RELIABLE NATIONAL ROAD SYSTEM, Asset Preservation Program, Rehabilitation/ Reconstruction/ Upgrading of Damaged Paved Roads - Secondary Roads, Santander-Barili-Toledo Rd - K0221 + 004 - K0221 + 822","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,23023000.0,0.803280522086609,18493927.46,15488664.25,4529072.539999999,0.0,1849392.75,6378465.289999999,6095398.25,"",0.9553],["25HO0106","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastucture Program (BIP), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/Facilities, Construction of Tubod River Flood Control, Barangay Tubod - Duguan, Dumanjug, Cebu (Phase 3)","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,145530000.0,0.8971947212945783,130568747.78999999,115114807.253125,14961252.210000008,0.0,7293393.8,22254646.01000001,21319567.746875003,"",0.569],["25HO0107","Convergence and Special Support Program, Basic Infrastructure Program (BIP), Flood Mitigation Structures Protecting Major/Strategic Public Buildings/Facilities, Construction of Revetment Wall at Brgy. Kanghalo (Downstream), Dumanjug, Cebu (Phase 3)","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,145529000.0,0.8016806521037044,116667783.62,100619654.60375,28861216.379999995,0.0,8756392.54,37617608.919999994,35813782.896249995,"",0.6751],["25HO0110","Convergence and Special Support Program, Basic Infrastructure Program (BIP), Flood Mitigation Structures protecting Major/ Strategic Buildings/ Facilities, Construction of River Protection Structures at Sitio Walog, Barangay Balaygtiki, Dumanjug, Cebu, (Package 3)","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,68260000.0,0.6560757333723997,44783729.56,41027565.6,23476270.439999998,0.0,4478372.96,27954643.4,22966184.4,"",0.15],["25HO0111","ORGANIZATIONAL OUTCOME : Ensure Safe and Reliable National Road System, Asset Preservation Program, Rehabilitation/ Reconstruction/Upgrading of Damaged Paved Roads - Secondary Roads, Santander-Barili-Toledo Rd - K0205 + 470 - K0206 + 000","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","ROADS","ALCANTARA, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48019000.0,0.8993071036464734,43183827.81,36166455.79,4835172.189999998,0.0,4318382.78,9153554.969999999,8851356.71,"",0.3125],["25HO0112","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Rehabilitation/ Reconstruction/ Upgrading of Damaged Paved Roads - Secondary Roads, Santander-Barili-Toledo Rd - K0194 + 148-K0195 + 000","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48018000.0,0.0,0.0,null,48018000.0,0.0,0.0,48018000.0,45016875.0,"",0.125],["25HO0118","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/ or Bridges from the National Road/s leading to Major/ Strategic Public Buildings/ Facilities,Construction of Road, Barangay Doldol - Barangay Bulak, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854500.0,0.3548601773648351,50338513.03,42158504.665625006,91515986.97,0.0,5033851.3,96549838.27,90830089.084375,"",0.1],["25HO0129","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall along Putaw River, Barangay Manlapay - Barangay Bulak, Upstream, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,24010000.0,0.8930421949187839,21441943.1,18342987.85,2568056.8999999985,0.0,2144194.31,4712251.209999999,4166387.1499999985,"",null],["25HO0130","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Tubod Duguan - Barangay Bulak, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141855000.0,0.35049826287406155,49719931.08,41640442.277499996,92135068.92,0.0,4971993.11,97107062.03,91348620.2225,"",0.1],["25HO0131","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Bulak - Barangay Tubod Duguan, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854500.0,0.34448231328579637,48866366.31,40925581.785625,92988133.69,0.0,4886636.63,97874770.32,92063011.96437499,"",0.1],["25HO0132","ORGANIZATIONAL OUTCOME 1: ENSURE SAFE AND RELIABLE NATIONAL ROAD SYSTEM., NETWORK DEVELOPMENT PROGRAM, CONSTRUCTION OF BY-PASS AND DIVERSION ROADS, DUMANJUG BYPASS ROAD, BRGY. COGON-BRGY. LIONG DUMANJUG, CEBU (PACKAGE 2)","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854000.0,0.5037130544080534,71453711.62,59842483.48,70400288.38,0.0,7145371.16,77545659.53999999,73145641.52000001,"",0.1746],["25HO0134","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Bulak - Barangay Doldol, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141855500.0,0.3514437586135187,49854230.1,41752917.70875001,92001269.9,0.0,4985423.01,96986692.91000001,91236613.54124999,"",0.0056],["25HO0135","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Sitio Cambinocot to Sitio Tumandoc, Barangay Legaspi, Alegria, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","ROADS","ALEGRIA, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141855000.0,0.3350459020126185,47527936.43,39804646.763124995,94327063.57,0.0,4752793.64,99079857.21,93184415.736875,"",0.1822],["25HO0136","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major / Strategic Public Buildings/ Facilities, Construction of Road, Barangay Doldol - Barangay Manlapay, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854000.0,0.3509833328633666,49788389.7,41697776.37375,92065610.3,0.0,4978838.97,97044449.27,91290348.62625,"",0.1],["25HO0137","ORGANIZATIONAL OUTCOME 1 : Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Secondary Roads, Santander-Barili-Toledo Rd - K0187+000 - K0188+000","CEBU 7TH","QM BUILDERS","JASON CARIN","ASPHALTING","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,94570000.0,0.15,14185500.0,14185500.0,80384500.0,0.0,0.0,80384500.0,74473875.0,"",0.3428],["25HO0140","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Revetment Wall along Putaw River, Barangay Manlapay - Barangay Doldol, Upstream, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,24010000.0,0.8932663627655144,21447325.37,19218944.939999998,2562674.629999999,0.0,1272202.65,3834877.279999999,3290430.0600000024,"",0.1325],["25HO0145","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road at Barangay Kanyuko - Barangay Tubod Bitoon (Package 2), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141855000.0,0.8016948620774734,113724424.66,104145169.278125,28130575.340000004,0.0,7092183.81,35222759.150000006,28843893.221874997,"",0.2136],["25HO0146","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road at Barangay Bulak - Barangay Doldol, Dumanjug, Cebu Phase 2","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854500.0,0.35170731481905754,49891265.29,41783934.680374995,91963234.71000001,0.0,4989126.529,96952361.23900001,91204659.069625,"",0.1],["25HO0147","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Tubod Duguan - Barangay Bulak, Dumanjug, Cebu Phase 1","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141855000.0,0.3054414423883543,43328395.81,36287531.49187501,98526604.19,0.0,4332839.58,102859443.77,96701531.00812499,"",0.1],["25HO0148","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Bulak - Barangay Tubod Duguan, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854000.0,0.3558603865241728,50480219.27,42277183.635625005,91373780.72999999,0.0,5048021.93,96421802.66,90710941.364375,"",0.1],["25HO0149","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure, Program (BIP), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Brgy. Kantangkas- Brgy. Paculob Road, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,145529500.0,0.28945767710326775,42124631.02,35279378.47925001,103404868.97999999,0.0,4212463.102000001,107617332.08199999,101154527.77074999,"",0.1],["25HO0150","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Seawall Protection Structure along Santander-Barili-Toledo Road at Sitio Mandag-om, Brgy. Matutinao, Badian, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","BADIAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,145530000.0,0.5088822664742665,74057636.24,62023270.355,71472363.76,0.0,7405763.62,78878127.38000001,74411104.64500001,"",0.3428],["25HO0151","CONVERGENCE AND SPECIAL SUPPORT PROGRAM Basic Infrastructure Program (BIP) Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities Construction of Seawall Protection Structure along Santander-Barili-Toledo Road at Sitio Lutak, Barangay Guiwanon, Ginatilan, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","GINATILAN, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,145529000.0,0.7050000643857925,102597954.37,85925786.7825,42931045.629999995,0.0,10259795.440000001,53190841.06999999,50507650.7175,"",0.998],["25HO0152","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Basic Infrastructure Program (BIP) Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Seawall Protection Structure at Brgy. Legaspi, Alegria, Cebu","CEBU 7TH","QM BUILDERS","JASON CARIN","FLOOD CONTROL","ALEGRIA, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,97020000.0,0.7050016270871985,68399257.86,57284378.45375,28620742.14,0.0,6839925.79,35460667.93,33671871.54625,"",0.891],["25HO0158","LOCALLY-FUNDED PROJECTS, National Building Program, Buildings and Other Structures - Multipurpose/ Facilities, Construction of Employees Quarters and Integrated Multi-Purpose Building (Package 2), DPWH Cebu 7th DEO, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141855000.0,0.3000224138028268,42559679.51,35643731.59,99295320.49000001,0.0,4255967.95,103551288.44000001,97345330.91,"",0.2197],["25HO0160","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Bulak - Barangay Tubod Duguan, Dumanjug, Cebu Phase 2","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854000.0,0.35108391733754424,49802658.01,41709726.084375,92051341.99000001,0.0,4980265.8,97031607.79,91278398.915625,"",0.1],["25HO0161","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road at Barangay Tubod Bitoon - Barangay Panlaan (Package 2), Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141853500.0,0.3511943111026517,49818142.21,41722694.101875,92035357.78999999,0.0,4981814.22,97017172.00999999,91264962.148125,"",0.1],["25HO0163","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/ or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Manlapay - Barangay Doldol, Dumanjug, Cebu Phase 2","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141853000.0,0.36062591971970986,51155868.59,42843039.943125,90697131.41,0.0,5115586.86,95812718.27,90144147.55687499,"",0.1],["25HO0164","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/ or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Tubod Duguan - Barangay Bulak, Dumanjug, Cebu Phase 3","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141852500.0,0.35073949095010665,49753273.64,41668366.6775,92099226.36,0.0,4975327.36,97074553.72,91318352.07249999,"",0.1],["25HO0166","ORGANIZATIONAL OUTCOME 1: Ensure Safe and Reliable National Road System, Asset Preservation Program, Preventive Maintenance - Secondary Roads, Santander-Barili-Toledo Rd - K0201+148 - K0202+923","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","ASPHALTING","MOALBOAL, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,94570000.0,0.815907342920588,77160357.42,64621799.34,17409642.58,0.0,7716035.74,25125678.32,24037575.659999996,"",0.3625],["25HO0167","LOCALLY-FUNDED PROJECTS, National Building Program, Buildings And Other Structures, Multipurpose / Facilities, Construction of Central Repository Building, DPWH-Cebu 7th District Engineering Office, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","BUILDING","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48020000.0,0.7515301468138276,36088477.65,32014067.320625,11931522.350000001,0.0,3608847.77,15540370.120000001,13004682.679375,"",0.4],["25HO0181","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Access Roads and/ or Bridges from the National Roads leading to Major/ Strategic Public Buildings/ Facilities, Construction of Road, Barangay Doldol - Barangay Bulak, Dumanjug, Cebu Phase 3","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","ROADS","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,141854500.0,0.0,0.0,null,141854500.0,0.0,0.0,141854500.0,132988593.75,"",0.1],["B-161-2024","TO HIRE CONTRACTOR TO PROVIDE MATERIALS, LABOR AND EQUIPMENT FOR THE \"REHABILITATION AND IMPROVEMENT OF BONAWON- CALANGAG- CANTIBAN- SAN FRANCISCO ROAD, SIATON AND STA. CATALINA, NEGROS ORIENTAL","PROVINCE OF NERGOS ORIENTAL","QM BUILDERS","CHARISSA DAGO-OC","ROADS","NEGROS ORIENTAL","COMPLETED","PROVINCE OF NEGROS ORIENTAL",2024,14691507.7,1.0,14691507.7,13773288.469999999,0.0,0.0,0.0,0.0,0.0,"",1.0],["CAPITOL BLDG.","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","ONGOING","PROVINCE OF DINAGAT ISLANDS",0,49893262.78,0.4183966084167967,20875171.93,21835670.130000003,29018090.85,0.0,2087517.19,31105608.040000003,24939263.72625,"",null],["25HE0091","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","SUSPENDED","DPWH Cebu 2ND DEO",0,37828000.0,0.0,0.0,null,37828000.0,0.0,0.0,37828000.0,35463750.0,"",null],["25HO0113","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Looc-Poblacion Seawall, Phase 3, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,47526000.0,0.8919834890375794,42392407.3,35503641.11,5133592.700000003,0.0,4239240.73,9372833.430000003,9051983.89,"",0.6603],["25HO0120","CONVERGENCE AND SPECIAL SUPPORT PROGRAM,Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Drainage Structure, DPWH - Cebu 7th DEO Compound, Barangay Cogon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GERISZA CARLA ENERO","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48020000.0,0.5056594114952103,24281764.94,20335978.14,23738235.06,0.0,2428176.49,26166411.549999997,24682771.86,"",null],["25HO0155","CONVERGENCE AND SPECIAL SUPPORT PROGRAM, Sustainable Infrastructure Projects Alleviating Gaps (SIPAG), Flood Mitigation Structures protecting Major/ Strategic Public Buildings/ Facilities, Construction of Slope Protection Structure, DPWH - Cebu 7th DEO Compound, Barangay Cogon, Dumanjug, Cebu","CEBU 7TH","QM BUILDERS","GLICERIO BRA\u00d1ANOLA","FLOOD CONTROL","DUMANJUG, CEBU","ONGOING","DPWH Cebu 7th DEO",2025,48020000.0,0.8042101976259891,38618173.69,32342720.47,9401826.310000002,0.0,3861817.37,13263643.680000003,12676029.530000001,"",0.1412],["24HG0107","LOCAL PROGRAM - Buildings And Other Structures - Multipurpose / Facilities - National Building Program - Construction of 3 - Storey Office Building - DPWH Cebu 4th DEO, Phase II, Dalaguete, Cebu","CEBU 2ND","QM BUILDERS","JASON CARIN","BUILDING","DALAGUETE, CEBU","ONGOING","DPWH Cebu 2ND DEO",2024,39170000.0,0.0,0.0,null,39170000.0,0.0,0.0,39170000.0,36721875.0,"",null],["24HO0051","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","ONGOING","DPWH Cebu 7th DEO",0,38597654.52,0.5360184523461038,20689055.04,17327083.6,17908599.480000004,0.0,2068905.5,19977504.980000004,18858217.512500003,"",null],["PRDP-SU-IB-R007-CEB-004-TUB-001-2023-FMR","","UNSPECIFIED","UNSPECIFIED","UNASSIGNED","UNSPECIFIED","UNSPECIFIED","ONGOING","LGU TUBURAN",0,353000000.0,0.2007925779036827,70879780.0,59361815.74,282120220.0,0.0,7087978.01,289208198.01,271575684.26,"",null]];
const SNAPSHOT_LABEL = "Built-in snapshot · collectibles 3 Aug 2026";

/* ---------------- parsing helpers ---------------- */

const NORM = (s) => String(s ?? "").toUpperCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
const CLEAN = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
const KEY = (v) => NORM(v);

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/[()]/g, "").replace(/[^0-9.-]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return /^\(/.test(String(v)) ? -n : n;
}

const LIC_MAP = {
  "QM BUIDERS": "QM BUILDERS", "QMB": "QM BUILDERS", "QM BUILDER": "QM BUILDERS",
  "QG DEVELOPMENT CORPORATION": "QG DEVELOPMENT CORP.",
  "ADAMANT DEVELOPMENT CORPORATION": "ADAMANT DEVELOPMENT CORP.",
};
const normLic = (s) => { const v = NORM(s); return LIC_MAP[v] || v; };
const normStatus = (s) => NORM(s).replace("ON-GOING", "ONGOING").replace("ON GOING", "ONGOING");

function findSheet(wb, tests) {
  return wb.SheetNames.find((n) => tests.some((t) => t(NORM(n))));
}
function grid(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
}
function headerRow(g) {
  for (let i = 0; i < Math.min(12, g.length); i++)
    if ((g[i] || []).some((c) => NORM(c).includes("PROJECT ID"))) return i;
  return 0;
}
/** exact matches win over partial ones, so "GROSS AMOUNT" never grabs "COLLECTIBLE GROSS AMOUNT" */
function findCol(headers, exacts = [], parts = []) {
  for (const e of exacts) { const i = headers.indexOf(NORM(e)); if (i > -1) return i; }
  for (const p of parts) {
    const needles = Array.isArray(p) ? p.map(NORM) : [NORM(p)];
    const i = headers.findIndex((h) => needles.every((n) => h.includes(n)));
    if (i > -1) return i;
  }
  return -1;
}

/* ---------------- readers ---------------- */

function readMaster(wb) {
  const log = [];
  const dim = new Map();
  const want = [
    { test: (n) => n.includes("QMB PROJECT"), kind: "qmb" },
    { test: (n) => n.includes("QM LICENSE"), kind: "lic" },
  ];
  for (const w of want) {
    const sn = wb.SheetNames.find((n) => w.test(NORM(n)));
    if (!sn) { log.push({ warn: true, text: `Sheet for ${w.kind === "qmb" ? "QMB Projects" : "QM Licenses"} not found` }); continue; }
    const g = grid(wb, sn);
    const hr = headerRow(g);
    const H = (g[hr] || []).map(NORM);
    const c = {
      id: findCol(H, ["PROJECT ID"], ["PROJECT ID"]),
      district: findCol(H, ["DISTRICT"], ["DISTRICT"]),
      location: findCol(H, ["LOCATION"], ["LOCATION"]),
      category: findCol(H, ["PROJECT CATEGORY"], ["CATEGORY"]),
      engineer: findCol(H, ["SENIOR ENGINEER"], [["SENIOR", "ENGINEER"]]),
      name: findCol(H, ["PROJECT NAME"], ["PROJECT NAME"]),
      year: findCol(H, ["YEAR", "PROJECT YEAR"], ["YEAR"]),
      contract: findCol(H, ["CONTRACT AMOUNT/ REVISED", "CONTRACT AMOUNT", "CONTRACT COST"], ["CONTRACT AMOUNT"]),
      license: w.kind === "lic"
        ? findCol(H, ["CONTRACTORS LICENSE"], [["CONTRACTOR", "LICENSE"]])
        : findCol(H, ["LICENSE"], ["LICENSE"]),
      status: w.kind === "lic" ? findCol(H, ["PROJECT STATUS BASED ON ACTUAL"], [["PROJECT STATUS"]]) : -1,
      swa: w.kind === "lic" ? findCol(H, ["SWA %"], ["SWA"]) : -1,
    };
    if (c.id < 0) { log.push({ warn: true, text: `${sn}: no Project ID column` }); continue; }

    let n = 0;
    for (let r = hr + 1; r < g.length; r++) {
      const row = g[r] || [];
      const id = KEY(row[c.id]);
      if (!id || id === "TOTAL") continue;
      const d = dim.get(id) || {};
      const put = (f, i, fn) => {
        if (i < 0 || d[f]) return;
        const v = fn ? fn(row[i]) : CLEAN(row[i]);
        if (v && v !== "-") d[f] = v;
      };
      // QM Licenses is the authority on license; QMB Projects on everything else it carries
      put("license", c.license, normLic);
      put("engineer", c.engineer, NORM);
      put("district", c.district, NORM);
      put("category", c.category, NORM);
      put("location", c.location, NORM);
      put("name", c.name);
      put("status", c.status, NORM);
      if (!d.year) { const y = toNum(row[c.year]); if (y) d.year = Math.round(y); }
      if (d.swa === undefined && c.swa >= 0) { const w2 = toNum(row[c.swa]); if (w2 !== null) d.swa = w2; }
      if (!d.contract) { const a = toNum(row[c.contract]); if (a) d.contract = a; }
      dim.set(id, d);
      n++;
    }
    log.push({ text: `${sn}: ${n} rows read` });
  }
  return { dim, log };
}

function readCollectibles(wb) {
  const log = [];
  const sn = findSheet(wb, [(n) => n.includes("COLLECTIBLE")]);
  if (!sn) return { rows: null, log: [{ warn: true, text: "No sheet named COLLECTIBLES found" }] };
  const g = grid(wb, sn);
  const hr = headerRow(g);
  const H = (g[hr] || []).map(NORM);
  const c = {
    id: findCol(H, ["PROJECT ID#", "PROJECT ID"], ["PROJECT ID"]),
    office: findCol(H, ["IMPLEMENTING OFFICE"], ["IMPLEMENTING"]),
    contract: findCol(H, ["CONTRACT AMOUNT"], ["CONTRACT AMOUNT"]),
    billpct: findCol(H, ["BILLING %"], ["BILLING"]),
    gross: findCol(H, ["GROSS AMOUNT"], []),
    net: findCol(H, ["NET AMOUNT (CHECK AMOUNT)"], [["NET AMOUNT", "CHECK"]]),
    cg: findCol(H, ["COLLECTIBLE GROSS AMOUNT"], [["COLLECTIBLE", "GROSS"]]),
    cc: findCol(H, ["COLLECTIBLE CASH BAL"], [["COLLECTIBLE", "CASH"]]),
    cr: findCol(H, ["COLLECTIBLE RETENTION"], [["COLLECTIBLE", "RETENTION"]]),
    bal: findCol(H, [], [["BALANCE FOR COLLECTION"]]),
    netbal: findCol(H, [], [["NET BAL", "COLLECTION"]]),
    status: findCol(H, ["STATUS"], ["STATUS"]),
    remarks: findCol(H, ["REMARKS"], ["REMARKS"]),
  };
  if (c.id < 0) return { rows: null, log: [{ warn: true, text: `${sn}: no Project ID column` }] };

  const rows = [];
  const seen = new Set();
  const get = (row, i) => (i < 0 ? null : toNum(row[i]));
  for (let r = hr + 1; r < g.length; r++) {
    const row = g[r] || [];
    const raw = CLEAN(row[c.id]);
    const id = KEY(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      key: id, id: raw,
      office: CLEAN(row[c.office]) || "UNSPECIFIED",
      status: normStatus(row[c.status]),
      remarks: CLEAN(row[c.remarks]),
      contract: get(row, c.contract), billpct: get(row, c.billpct),
      gross: get(row, c.gross), net: get(row, c.net),
      cg: get(row, c.cg), cc: get(row, c.cc), cr: get(row, c.cr),
      bal: get(row, c.bal), netbal: get(row, c.netbal),
    });
  }
  log.push({ text: `${sn}: ${rows.length} projects read` });
  const missing = Object.entries(c).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) log.push({ warn: true, text: `Columns not matched: ${missing.join(", ")}` });
  return { rows, log };
}

/* ---------------- assembly ---------------- */

function assemble(coll, dim) {
  return coll.map((m) => {
    const d = dim.get(m.key) || {};
    const r = {
      id: m.id,
      name: d.name || "",
      district: d.district || "UNSPECIFIED",
      license: d.license || "UNSPECIFIED",
      engineer: d.engineer || "UNASSIGNED",
      category: d.category || "UNSPECIFIED",
      location: d.location || "UNSPECIFIED",
      status: m.status || d.status || "UNSPECIFIED",
      swa: d.swa ?? null,
      office: m.office,
      year: d.year || 0,
      /* these five come strictly from the collectibles workbook — no master fallback,
         so a blank there shows as blank rather than quietly borrowing an older figure */
      contract: m.contract ?? null,
      billpct: m.billpct, gross: m.gross, net: m.net,
      cg: m.cg, cc: m.cc, cr: m.cr, bal: m.bal, netbal: m.netbal,
      remarks: m.remarks,
    };
    r.yearStr = r.year ? String(r.year) : "UNSPECIFIED";
    r._hay = [r.id, r.name, r.district, r.license, r.engineer, r.category,
      r.location, r.status, r.office, r.remarks].join(" ").toLowerCase();
    return r;
  });
}

/* snapshot → the same {coll, dim} shape, so an import of one file alone still works */
function snapshotState() {
  const dim = new Map();
  const coll = SNAPSHOT.map((a) => {
    const o = {};
    SNAP_FIELDS.forEach((f, i) => (o[f] = a[i]));
    const key = KEY(o.id);
    dim.set(key, {
      name: o.name, district: o.district, license: o.license, engineer: o.engineer,
      category: o.category, location: o.location, year: o.year, contract: o.contract, swa: o.swa,
    });
    return {
      key, id: o.id, office: o.office, status: o.status, remarks: o.remarks,
      contract: o.contract, billpct: o.billpct, gross: o.gross, net: o.net,
      cg: o.cg, cc: o.cc, cr: o.cr, bal: o.bal, netbal: o.netbal,
    };
  });
  return { coll, dim };
}

/* ---------------- manual entries ----------------
   Targets, dates, actual output and remarks are typed in by hand, so they must
   survive a re-import. They live in their own store keyed by project ID and are
   never touched by the Excel readers — importing replaces only the imported
   columns and leaves everything below untouched.
------------------------------------------------- */

async function loadManual() {
  if (!isConfigured || !supabase) return {};
  const { data, error } = await supabase.from("project_manual_updates")
    .select("project_id, target_qty, unit, start_date, target_completion, actual_output, remarks");
  if (error) throw error;
  return Object.fromEntries((data || []).map((row) => [row.project_id, {
    target: row.target_qty, unit: row.unit, start: row.start_date,
    due: row.target_completion, actual: row.actual_output, note: row.remarks,
  }]));
}
async function saveManualRow(id, values, oldValues, userId, username) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.from("project_manual_updates").upsert({
    project_id: id,
    target_qty: values.target === "" || values.target === null ? null : toNum(values.target),
    unit: values.unit || null,
    start_date: values.start || null,
    target_completion: values.due || null,
    actual_output: values.actual === "" || values.actual === null ? null : toNum(values.actual),
    remarks: values.note || null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  if (error) throw error;

  const auditFields = [
    ["target", "Target qty"], ["unit", "Unit"], ["start", "Start date"],
    ["due", "Target completion"], ["actual", "Actual output"], ["note", "Remarks"],
  ];
  const changes = auditFields
    .filter(([field]) => String(oldValues?.[field] ?? "") !== String(values?.[field] ?? ""))
    .map(([field, label]) => ({
      project_id: id,
      column_name: label,
      old_value: oldValues?.[field] ?? null,
      new_value: values?.[field] ?? null,
      changed_by: userId,
      changed_by_username: username || "Unknown user",
    }));
  if (changes.length) {
    const { error: auditError } = await supabase.from("project_manual_update_audit").insert(changes);
    if (auditError) throw auditError;
  }
}

const DAY = 86400000;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
function daysUntil(due) {
  if (!due) return null;
  const t = Date.parse(due + "T00:00:00");
  return isNaN(t) ? null : Math.round((t - today0()) / DAY);
}
const fmtDate = (s) => {
  if (!s) return "";
  const t = Date.parse(s + "T00:00:00");
  if (isNaN(t)) return s;
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/* ---------------- presentation ---------------- */

const DIMS = [
  { k: "district", label: "District", w: 190 },
  { k: "category", label: "Project category", w: 190 },
  { k: "license", label: "License", w: 260 },
  { k: "yearStr", label: "Project year", w: 140 },
  { k: "engineer", label: "Senior engineer", w: 210 },
  { k: "office", label: "Implementing office", w: 250 },
  { k: "location", label: "Location", w: 220 },
  { k: "status", label: "Status", w: 160 },
  { k: "hasTarget", label: "Targets", w: 150 },
];

const T = {
  paper: "#E9EDE7", paper2: "#F4F7F2", panel: "#FFFFFF",
  ink: "#16211C", inkSoft: "#4C5B53", inkFaint: "#7F8D84",
  rule: "#C6CEC4", ruleSoft: "#DEE4DA",
  collected: "#0E5B57", works: "#9A4B12", retention: "#6E6014", cash: "#3C6E9E", bad: "#8C2F26",
};
const DISPLAY = '"Archivo","Helvetica Neue",system-ui,sans-serif';
const BODY = '"IBM Plex Sans",system-ui,-apple-system,sans-serif';
const MONO = '"IBM Plex Mono",ui-monospace,Menlo,monospace';

const P = "\u20B1";
const money = (n) => n === null || n === undefined || !isFinite(n) ? "—"
  : (n < 0 ? "-" : "") + P + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const compact = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return s + P + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + P + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + P + (a / 1e3).toFixed(0) + "K";
  return money(n);
};
const qty = (n) => (n === null || n === undefined || n === "" || isNaN(Number(n)))
  ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (n) => (n === null || n === undefined || !isFinite(n) ? "—" : (n * 100).toFixed(1) + "%");
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);

const COLS = [
  { k: "id", label: "ID", stick: true, w: 92 },
  { k: "district", label: "District" },
  { k: "license", label: "License" },
  { k: "engineer", label: "Senior engineer" },
  { k: "category", label: "Category" },
  { k: "location", label: "Location" },
  { k: "status", label: "Status", pill: true },
  { k: "contract", label: "Contract", money: true, w: 101 },
  { k: "swa", label: "SWA %", pct: true },
  { k: "billpct", label: "Billed %", pct: true },
  { k: "net", label: "Collected (net)", money: true, group: "collection" },
  { k: "cg", label: "Balance works", money: true, group: "collection" },
  { k: "cr", label: "Retention", money: true, group: "collection" },
  { k: "bal", label: "Balance for collection", money: true, w: 119, group: "collection" },
  { k: "netbal", label: "Net balance", money: true, group: "collection" },
  { k: "target", label: "Target qty", edit: "qty", w: 84 },
  { k: "unit", label: "Unit", edit: "text", w: 76 },
  { k: "start", label: "Start date", edit: "date", w: 128 },
  { k: "due", label: "Target completion", edit: "date", w: 132 },
  { k: "actual", label: "Actual output", edit: "qty", w: 88 },
  { k: "note", label: "Remarks", edit: "text", w: 190 },
];

const AUDIT_FIELD_LABELS = Object.fromEntries(COLS.filter((c) => c.edit).map((c) => [c.k, c.label]));

/* the table hides the long project name; the export still carries it */
const EXPORT_COLS = [
  COLS[0],
  { k: "name", label: "Project name" },
  ...COLS.slice(1),
];

function Panel({ title, right, children }) {
  return (
    <section className="mb-3 rounded-sm"
             style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -20px rgba(22,33,28,.6)",
                      height: "100%", display: "flex", flexDirection: "column" }}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <h3 className="text-[11px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 700 }}>{title}</h3>
          {right}
        </div>
      )}
      <div className="p-3" style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, meta, color }) {
  return (
    <div className="rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, borderTop: `3px solid ${color || T.ink}` }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>{label}</div>
      <div className="mt-1 text-xl leading-tight" style={{ fontFamily: MONO, fontWeight: 600, color: color || T.ink }}>{value}</div>
      <div className="mt-0.5 text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>{meta}</div>
    </div>
  );
}

function Meter({ label, segments, legend }) {
  const total = segments.reduce((t, s) => t + Math.max(0, s.value || 0), 0) || 1;
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>{label}</div>
      <div className="flex h-7 overflow-hidden" style={{ border: `1px solid ${T.ink}`, background: T.paper2 }}>
        {segments.map((s, i) => (
          <div key={i} title={`${s.label} — ${money(s.value)}`}
               style={{ width: (Math.max(0, s.value || 0) / total) * 100 + "%", background: s.color, transition: "width .35s ease" }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: T.inkSoft }}>
        {legend.map((l, i) => (
          <span key={i}>
            {l.color && <span className="mr-1.5 inline-block h-2.5 w-2.5 align-[-1px]" style={{ background: l.color }} />}
            {l.label} <b style={{ fontFamily: MONO, color: T.ink }}>{l.value}</b>
            {l.extra ? <span style={{ color: T.inkFaint }}> · {l.extra}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- import panel ---------------- */

function ImportPanel({ onLoad, sourceLabel, log, busy, onReset, canReset }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  const take = (files) => { if (files && files.length) onLoad([...files]); };

  return (
    <div className="mb-4 rounded-sm" style={{ background: T.panel, border: `1px solid ${T.rule}` }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="text-[11.5px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
          Data source: <b style={{ color: T.ink }}>{sourceLabel}</b>
        </div>
        <div className="flex items-center gap-2">
          {canReset && (
            <button onClick={onReset} className="rounded-sm px-2.5 py-1 text-xs"
                    style={{ border: `1px solid ${T.rule}`, color: T.inkSoft }}>Back to snapshot</button>
          )}
          <button onClick={() => setOpen(!open)} className="rounded-sm px-2.5 py-1 text-xs"
                  style={{ border: `1px solid ${T.ink}`, background: open ? T.ink : T.panel, color: open ? T.paper2 : T.ink }}>
            {open ? "Close" : "Update from Excel"}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-3 pb-3" style={{ borderTop: `1px solid ${T.ruleSoft}` }}>
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
            className="mt-3 rounded-sm px-4 py-7 text-center"
            style={{ border: `2px dashed ${over ? T.collected : T.rule}`, background: over ? "#F0F6F4" : T.paper2 }}
          >
            <div className="text-sm" style={{ fontFamily: DISPLAY, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" }}>
              Drop the two workbooks here
            </div>
            <p className="mx-auto mt-1.5 max-w-xl text-xs" style={{ color: T.inkSoft }}>
              The project master workbook (read from <b>QMB Projects</b> and <b>QM Licenses</b>) and the
              updated collectibles workbook (read from <b>Collectibles</b>). Drop either one on its own or both
              together — each file is identified by its sheet names, so the order doesn't matter. Everything is
              parsed in this browser; nothing is uploaded.
            </p>
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.xlsm" multiple hidden
                   onChange={(e) => take(e.target.files)} />
            <button onClick={() => inputRef.current && inputRef.current.click()} disabled={busy}
                    className="mt-3 rounded-sm px-3 py-1.5 text-xs"
                    style={{ border: `1px solid ${T.ink}`, background: T.ink, color: T.paper2, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Reading…" : "Choose files"}
            </button>
          </div>

          {log.length > 0 && (
            <div className="mt-3 rounded-sm px-3 py-2" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
              {log.map((l, i) => (
                <div key={i} className="text-[11.5px]" style={{ fontFamily: MONO, color: l.warn ? T.bad : T.inkSoft }}>
                  {l.warn ? "! " : "· "}{l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- filter bar ---------------- */

function FilterDropdown({ dim, counts, selected, onToggle, onClearOne, open, onOpen }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => [...counts.entries()]
    .filter(([v]) => !q || v.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [counts, q]);

  const on = selected.size > 0;
  const summary = selected.size === 0 ? "All"
    : selected.size === 1 ? [...selected][0]
    : selected.size + " selected";

  return (
    <div className="relative" style={{ width: dim.w, minWidth: 130, flex: "1 1 auto", maxWidth: 320 }}>
      <div className="mb-1 text-[9.5px] uppercase"
           style={{ fontFamily: DISPLAY, fontWeight: 600, letterSpacing: ".09em", color: T.inkSoft }}>
        {dim.label}
      </div>
      <button
        onClick={() => onOpen(open ? null : dim.k)}
        className="flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs"
        style={{
          border: `1px solid ${on || open ? T.ink : T.rule}`,
          background: on ? T.ink : T.panel,
          color: on ? T.paper2 : T.ink,
          boxShadow: open ? `0 0 0 2px ${T.collected}33` : "none",
        }}
      >
        <span className="truncate" title={summary}>{summary}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {on && (
            <span className="rounded-full px-1.5 text-[9.5px]"
                  style={{ fontFamily: MONO, background: T.paper2, color: T.ink }}>{selected.size}</span>
          )}
          <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.7 }}>{open ? "\u25B2" : "\u25BC"}</span>
        </span>
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 rounded-sm p-2"
             style={{ top: "100%", width: Math.max(dim.w, 230), background: T.panel,
                      border: `1px solid ${T.ink}`, boxShadow: "0 18px 40px -20px rgba(22,33,28,.55)" }}>
          {counts.size > 8 && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="find\u2026"
                   className="mb-1.5 w-full rounded-sm px-2 py-1 text-xs" style={{ border: `1px solid ${T.rule}` }} />
          )}
          <div className="max-h-64 overflow-auto">
            {list.length === 0 && <div className="px-1 py-2 text-[11px]" style={{ color: T.inkFaint }}>No match.</div>}
            {list.map(([v, n]) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs"
                     style={{ opacity: n ? 1 : 0.4 }}>
                <input type="checkbox" checked={selected.has(v)} onChange={() => onToggle(dim.k, v)}
                       style={{ accentColor: T.collected }} />
                <span className="flex-1 truncate" title={v}>{v}</span>
                <span className="text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>{n}</span>
              </label>
            ))}
          </div>
          {on && (
            <button onClick={() => onClearOne(dim.k)}
                    className="mt-1.5 w-full rounded-sm py-1 text-[11px]"
                    style={{ border: `1px solid ${T.rule}`, color: T.inkSoft }}>
              Clear {dim.label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterBar({ q, setQ, filters, countsFor, onToggle, onClearOne, onClearAll, anyActive }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    const esc = (e) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="sticky top-0 z-20 mb-3 rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -22px rgba(22,33,28,.7)" }}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative" style={{ width: 220, minWidth: 160, flex: "1 1 auto", maxWidth: 320 }}>
          <div className="mb-1 text-[9.5px] uppercase"
               style={{ fontFamily: DISPLAY, fontWeight: 600, letterSpacing: ".09em", color: T.inkSoft }}>Search</div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, project name, remarks\u2026"
                 className="w-full rounded-sm px-2.5 py-1.5 text-xs"
                 style={{ border: `1px solid ${q ? T.ink : T.rule}` }} />
        </div>

        {DIMS.map((d) => (
          <FilterDropdown key={d.k} dim={d} counts={countsFor(d.k)} selected={filters[d.k]}
                          onToggle={onToggle} onClearOne={onClearOne}
                          open={open === d.k} onOpen={setOpen} />
        ))}

        <button onClick={onClearAll} disabled={!anyActive}
                className="rounded-sm px-2.5 py-1.5 text-[11px]"
                style={{ border: `1px solid ${T.rule}`, color: anyActive ? T.ink : T.inkFaint,
                         background: T.panel, opacity: anyActive ? 1 : 0.5, alignSelf: "flex-end" }}>
          Clear all
        </button>
      </div>
    </div>
  );
}

/* ---------------- charts ---------------- */

function GroupChart({ rows, groupBy, onGroupBy }) {
  const PLOT = 172;
  const HEAD = 15;          // headroom so a data label never overruns the panel
  const BAR = PLOT - HEAD;  // usable bar height
  const COLW = 66;
  const arr = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      const k = r[groupBy];
      if (!g.has(k)) g.set(k, { k, n: 0, net: 0, cg: 0, cr: 0, bal: 0 });
      const o = g.get(k);
      o.n++; o.net += r.net || 0; o.cg += r.cg || 0; o.cr += r.cr || 0; o.bal += r.bal || 0;
    });
    return [...g.values()].sort((a, b) => b.bal - a.bal);
  }, [rows, groupBy]);

  const show = arr.slice(0, 12);
  const max = Math.max(1, ...show.map((a) => Math.max(a.bal, a.net)));
  const h = (v) => Math.max(v > 0 ? 1 : 0, (v / max) * BAR);

  return (
    <Panel title="By group" right={
      <label className="text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
        Group by{" "}
        <select value={groupBy} onChange={(e) => onGroupBy(e.target.value)} className="ml-1 rounded-sm px-1.5 py-1 text-[12px]"
                style={{ border: `1px solid ${T.rule}`, background: T.panel }}>
          {DIMS.map((d) => <option key={d.k} value={d.k}>{d.label}</option>)}
        </select>
      </label>
    }>
      {show.length === 0 ? (
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint }}>Nothing to chart.</div>
      ) : (
        <div className="flex gap-2">
          {/* y axis */}
          <div className="relative shrink-0" style={{ width: 46, height: PLOT }}>
            {[1, 0.5, 0].map((f) => (
              <div key={f} className="absolute right-0 text-[9.5px]"
                   style={{ top: HEAD + (1 - f) * BAR - 6, fontFamily: MONO, color: T.inkFaint }}>
                {f === 0 ? "0" : compact(max * f)}
              </div>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto">
            {/* plot */}
            <div className="relative flex items-end" style={{ height: PLOT, borderBottom: `1px solid ${T.ink}` }}>
              {[1, 0.5].map((f) => (
                <div key={f} className="pointer-events-none absolute left-0 right-0"
                     style={{ top: HEAD + (1 - f) * BAR, borderTop: `1px dashed ${T.ruleSoft}` }} />
              ))}
              {show.map((a) => (
                <div key={a.k} className="flex items-end justify-center gap-1"
                     style={{ flex: "1 1 0", minWidth: COLW, padding: "0 3px" }}>
                  {/* balance for collection, stacked */}
                  <div className="flex flex-col items-center"
                       title={`${a.k} — balance for collection ${money(a.bal)} (works ${money(a.cg)}, retention ${money(a.cr)})`}>
                    <span style={{ fontFamily: MONO, fontSize: 8, lineHeight: "13px", whiteSpace: "nowrap",
                                   color: T.works, letterSpacing: "-.02em" }}>
                      {a.bal > 0 ? compact(a.bal) : ""}
                    </span>
                    <div className="flex flex-col justify-end" style={{ width: 24, height: h(a.bal) }}>
                      <div style={{ height: h(a.cr), background: T.retention }} />
                      <div style={{ height: h(a.cg), background: T.works }} />
                    </div>
                  </div>
                  {/* collected */}
                  <div className="flex flex-col items-center" title={`${a.k} — collected ${money(a.net)}`}>
                    <span style={{ fontFamily: MONO, fontSize: 8, lineHeight: "13px", whiteSpace: "nowrap",
                                   color: T.collected, letterSpacing: "-.02em" }}>
                      {a.net > 0 ? compact(a.net) : ""}
                    </span>
                    <div style={{ width: 24, height: h(a.net), background: T.collected }} />
                  </div>
                </div>
              ))}
            </div>

            {/* labels */}
            <div className="flex items-start">
              {show.map((a) => (
                <div key={a.k} title={`${a.k} · ${a.n} project${a.n === 1 ? "" : "s"}`}
                     className="text-center" style={{ flex: "1 1 0", minWidth: COLW, padding: "5px 2px 0" }}>
                  <div style={{
                    fontFamily: MONO, fontSize: 9, lineHeight: 1.2, color: T.inkSoft,
                    overflow: "hidden", overflowWrap: "anywhere", wordBreak: "break-word",
                    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", maxHeight: 33,
                  }}>
                    {a.k}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: T.inkSoft, marginTop: 7, lineHeight: 1.2 }}>
                    {a.n} Project{a.n === 1 ? "" : "s"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {show.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.works }} />unbilled works</span>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.retention }} />retention</span>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.collected }} />collected</span>
          <span>left column = balance for collection{arr.length > 12 ? ` · top 12 of ${arr.length}` : ""}</span>
        </div>
      )}
    </Panel>
  );
}

function StatusChart({ rows }) {
  const arr = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      if (!g.has(r.status)) g.set(r.status, { k: r.status, n: 0, bal: 0 });
      const o = g.get(r.status); o.n++; o.bal += r.bal || 0;
    });
    return [...g.values()].sort((a, b) => b.bal - a.bal);
  }, [rows]);
  const max = Math.max(1, ...arr.map((a) => a.bal));
  return (
    <Panel title="Balance for collection by project status">
      {arr.length === 0 && <div className="py-8 text-center text-xs" style={{ color: T.inkFaint }}>Nothing to chart.</div>}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-around", gap: 6 }}>
      {arr.map((a) => (
        <div key={a.k}>
          <div className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 truncate font-semibold" title={a.k}>{a.k}</span>
            <span className="h-3.5 flex-1" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
              <span className="block h-full" style={{ width: (a.bal / max) * 100 + "%", background: T.collected }} />
            </span>
            <span className="w-24 shrink-0 text-right text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft }}>{compact(a.bal)}</span>
          </div>
          <div className="mt-0.5 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint, marginLeft: 88 }}>
            {a.n} project{a.n === 1 ? "" : "s"}
          </div>
        </div>
      ))}
      </div>
    </Panel>
  );
}

/* ---------------- table ---------------- */

function EditCell({ value, type, onChange }) {
  const [focus, setFocus] = useState(false);
  const v = value ?? "";

  return (
    <input
      value={v}
      type={type === "date" ? "date" : "text"}
      inputMode={type === "qty" ? "decimal" : undefined}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
      style={{
        width: "100%", border: `1px solid ${focus ? T.collected : "transparent"}`,
        background: focus ? T.panel : "transparent", borderRadius: 2, padding: "1px 4px",
        fontFamily: type === "text" ? BODY : MONO, fontSize: 11.5, color: T.ink,
        textAlign: type === "qty" ? "right" : "left", outline: "none",
      }}
    />
  );
}

function AuditModal({ target, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    supabase.from("project_manual_update_audit")
      .select("id, column_name, old_value, new_value, changed_by_username, changed_at")
      .eq("project_id", target.projectId)
      .eq("column_name", AUDIT_FIELD_LABELS[target.field])
      .order("changed_at", { ascending: false })
      .then(({ data, error: queryError }) => {
        if (!alive) return;
        if (queryError) setError(queryError.message);
        else setLogs(data || []);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [target]);

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
         style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(22,33,28,.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="audit-title"
           style={{ width: "min(680px, 100%)", maxHeight: "80vh", overflow: "auto", background: T.panel,
                    border: `1px solid ${T.ink}`, borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div>
            <h2 id="audit-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, textTransform: "uppercase" }}>
              Audit trail · {AUDIT_FIELD_LABELS[target.field]}
            </h2>
            <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 11, color: T.inkSoft }}>Project ID: {target.projectId}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close audit trail"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, padding: "3px 8px", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {loading && <div style={{ color: T.inkFaint, fontSize: 12 }}>Loading audit history…</div>}
          {error && <div style={{ color: T.bad, fontSize: 12 }}>Could not load audit history: {error}</div>}
          {!loading && !error && !logs.length && <div style={{ color: T.inkFaint, fontSize: 12 }}>No saved changes for this cell yet.</div>}
          {!loading && !error && logs.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                {[["When", "left"], ["User", "left"], ["Previous value", "left"], ["New value", "left"]].map(([label, align]) => (
                  <th key={label} style={{ padding: "6px 7px", textAlign: align, borderBottom: `2px solid ${T.ink}`,
                                            fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{label}</th>
                ))}
              </tr></thead>
              <tbody>{logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap", fontFamily: MONO, fontSize: 10.5 }}>
                    {new Date(log.changed_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}` }}>{log.changed_by_username}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, color: T.inkSoft }}>{log.old_value ?? "—"}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, fontWeight: 600 }}>{log.new_value ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


function LedgerTable({ rows, sort, onSort, onExport, onEdit, onSaveRow, onSaveAll, onAuditCell, dirtyIds, dirtyCount, savingIds }) {
  const [showCollection, setShowCollection] = useState(false);
  /* the four collection-detail columns fold away by default; the export always
     carries every column regardless of what is on screen */
  const cols = useMemo(() => COLS.filter((c) => !c.group || showCollection), [showCollection]);
  const groupCount = COLS.filter((c) => c.group === "collection").length;
  const data = useMemo(() => {
    const d = rows.slice();
    const { key, dir } = sort;
    d.sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
      return String(x ?? "").localeCompare(String(y ?? "")) * dir;
    });
    return d;
  }, [rows, sort]);

  const th = { position: "sticky", top: 0, background: T.paper2, zIndex: 3, textAlign: "left", padding: "7px 9px",
    borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase",
    letterSpacing: ".06em", cursor: "pointer", whiteSpace: "nowrap" };
  const stick = { position: "sticky", left: 0, background: T.panel, zIndex: 2, borderRight: `1px solid ${T.rule}` };
  const pillColor = (s) => (s === "ONGOING" ? T.collected : s === "SUSPENDED" ? T.bad : T.inkFaint);

  return (
    <Panel title="Projects" right={
      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>({data.length})</span>
        <button onClick={() => setShowCollection(!showCollection)}
                className="rounded-sm px-3 py-1 text-xs"
                title="Collected (net), balance works, retention, balance for collection, net balance"
                style={{ border: `1px solid ${T.collected}`,
                         background: showCollection ? T.collected : "#E4EFEC",
                         color: showCollection ? T.paper2 : T.collected,
                         fontFamily: DISPLAY, fontWeight: 700, letterSpacing: ".04em",
                         textTransform: "uppercase", fontSize: 10.5, whiteSpace: "nowrap",
                         boxShadow: showCollection ? "none" : `0 0 0 2px ${T.collected}22` }}>
          {showCollection ? "▾ Hide" : "▸ Show"} collection detail ({groupCount})
        </button>
        <button onClick={onSaveAll} disabled={!dirtyCount || savingIds.size > 0}
                className="rounded-sm px-2.5 py-1 text-xs"
                style={{ border: `1px solid ${dirtyCount ? T.collected : T.rule}`,
                         background: dirtyCount ? T.collected : T.paper2,
                         color: dirtyCount ? T.paper2 : T.inkFaint,
                         fontFamily: DISPLAY, fontWeight: 700, cursor: dirtyCount ? "pointer" : "default" }}>
          {savingIds.size ? "Saving…" : `Save changes${dirtyCount ? ` (${dirtyCount})` : ""}`}
        </button>
        <button onClick={() => onExport(data)} className="rounded-sm px-2.5 py-1 text-xs"
                style={{ border: `1px solid ${T.rule}`, background: T.panel, color: T.inkSoft }}>Export filtered CSV</button>
      </div>
    }>
      {data.length === 0 ? (
        <div className="py-10 text-center text-xs" style={{ color: T.inkFaint }}>No projects match these filters.</div>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 620 }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.k} onClick={() => onSort(c.k)}
                      style={{ ...th, ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w,
                                                 whiteSpace: c.stick ? "nowrap" : "normal" } : {}),
                               color: c.edit ? "#C28A00" : T.ink,
                               ...(c.stick ? { ...stick, background: T.paper2, zIndex: 4 } : {}) }}>
                    {c.label}{c.edit && <span aria-hidden="true" style={{ color: T.bad, marginLeft: 3, fontWeight: 800 }}>*</span>} <span style={{ fontFamily: MONO, color: T.inkFaint }}>{sort.key === c.k ? (sort.dir > 0 ? "▲" : "▼") : "↕"}</span>
                  </th>
                ))}
                <th style={{ ...th, cursor: "default", width: 68, minWidth: 68 }}>Save</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r, ri) => (
                <tr key={r.id + "|" + ri}>
                  {cols.map((c) => {
                    const v = r[c.k];
                    const base = { padding: "6px 9px", borderBottom: `1px solid ${T.ruleSoft}`, verticalAlign: "top" };
                    const wStyle = c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden" } : {};
                    if (c.group) base.background = "#F2F6F1";
                    if (c.edit) return (
                      <td key={c.k} onContextMenu={(e) => {
                        e.preventDefault();
                        onAuditCell({ projectId: r.id, field: c.k, value: v });
                      }} onClick={(e) => {
                        if (e.target.tagName !== "INPUT") e.currentTarget.querySelector("input")?.focus();
                      }}
                          style={{ ...base, ...wStyle, padding: "3px 5px", background: "#FBFCFA", cursor: "text" }}>
                        <EditCell value={v} type={c.edit} onChange={(nv) => onEdit(r.id, c.k, nv)}
                        />
                      </td>
                    );
                    if (c.money) return <td key={c.k} style={{ ...base, ...wStyle, fontFamily: MONO, textAlign: "right", whiteSpace: "nowrap" }}>
                      {v ? money(v) : <span style={{ color: T.inkFaint }}>—</span>}</td>;
                    if (c.pct) return <td key={c.k} style={{ ...base, ...wStyle, fontFamily: MONO, textAlign: "right" }}>{pct(v)}</td>;
                    if (c.pill) return <td key={c.k} style={base}>
                      <span className="inline-block rounded-full px-2 py-px text-[10.5px]"
                            style={{ border: `1px solid ${pillColor(v)}`, color: pillColor(v) }}>{v}</span></td>;
                    return <td key={c.k} title={c.stick ? [v, r.name].filter(Boolean).join(" \u2014 ") : v} style={{ ...base,
                      ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden", textOverflow: "ellipsis" } : {}),
                      ...(c.stick ? { ...stick, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", padding: "6px 8px", fontSize: 11.5 } : {}),
                      ...(c.wide ? { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}) }}>{v}</td>;
                  })}
                  <td style={{ padding: "3px 5px", borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "center" }}>
                    <button type="button" title={`Save changes for ${r.id}`} aria-label={`Save changes for ${r.id}`}
                            onClick={() => onSaveRow(r.id)} disabled={!dirtyIds.has(r.id) || savingIds.has(r.id)}
                            style={{ border: `1px solid ${dirtyIds.has(r.id) ? T.collected : T.rule}`,
                                     background: dirtyIds.has(r.id) ? "#E4EFEC" : T.paper2,
                                     color: dirtyIds.has(r.id) ? T.collected : T.inkFaint, borderRadius: 2,
                                     padding: "2px 6px", cursor: dirtyIds.has(r.id) ? "pointer" : "default", fontSize: 13 }}>
                      {savingIds.has(r.id) ? "…" : "▣"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {cols.map((c, i) => {
                  const base = { position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}`,
                    padding: "7px 9px", fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", zIndex: 3 };
                  if (i === 0) return <td key={c.k} style={{ ...base, ...stick, background: T.paper2, zIndex: 4,
                    width: c.w, minWidth: c.w, maxWidth: c.w, padding: "7px 8px", fontSize: 11 }}>TOTAL</td>;
                  if (c.k === "district") return <td key={c.k} style={base}>{data.length} projects</td>;
                  if (c.money) return <td key={c.k} style={{ ...base, textAlign: "right",
                    ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden" } : {}) }}>{money(sum(data, c.k))}</td>;
                  if (c.k === "swa") {
                    const w2 = data.filter((r) => r.swa !== null && r.swa !== undefined);
                    const ct2 = sum(w2, "contract");
                    return <td key={c.k} style={{ ...base, textAlign: "right" }}>
                      {pct(ct2 ? w2.reduce((t, r) => t + r.swa * (r.contract || 0), 0) / ct2 : null)}</td>;
                  }
                  if (c.k === "billpct") { const ct = sum(data, "contract");
                    return <td key={c.k} style={{ ...base, textAlign: "right" }}>{pct(ct ? sum(data, "gross") / ct : null)}</td>; }
                  if (c.k === "target") return <td key={c.k} style={{ ...base, textAlign: "right" }}>
                    {data.filter((r) => r.target !== null && r.target !== undefined && r.target !== "").length}</td>;
                  return <td key={c.k} style={base} />;
                })}
                <td style={{ position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}` }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- target tracking ---------------- */

/* A project only enters this analysis once someone has set a target or a completion
   date. Actual output falls back to SWA % when the manual figure is blank, so a row
   is useful the moment a date is typed in. */
function assessTargets(rows) {
  const tracked = [];
  rows.forEach((r) => {
    const num = (x) => (x === null || x === undefined || x === "" || isNaN(Number(x)) ? null : Number(x));
    const target = num(r.target);
    const actual = num(r.actual) !== null ? num(r.actual) : (target !== null ? 0 : null);
    if (target === null && !r.due) return;

    const days = daysUntil(r.due);                 // days left until the deadline
    const sinceStart = r.start ? daysUntil(r.start) : null;
    const elapsed = sinceStart === null ? null : Math.max(0, -sinceStart);
    const gap = target !== null && actual !== null ? target - actual : null;
    const remaining = gap !== null ? Math.max(0, gap) : null;
    const progress = target ? Math.min(actual / target, 2) : null;
    const done = target !== null && actual !== null && actual >= target;

    /* Demonstrated capacity: what the crew has actually produced per day since
       starting. Multiply by the days left and compare against the quantity still
       outstanding — that answers whether the remaining time can absorb the
       remaining work, rather than merely whether they are behind today. */
    const capacity = elapsed !== null && elapsed > 0 && actual !== null && actual > 0 ? actual / elapsed : null;
    const canDeliver = capacity !== null && days !== null && days > 0 ? capacity * days : null;
    const needRate = remaining !== null && days !== null && days > 0 ? remaining / days : null;
    const pace = capacity !== null && needRate ? capacity / needRate : null;   // 1.0 = exactly enough

    let bucket, rank;
    /* Standing is intentionally based on the values the user entered. The
       previous capacity calculation could call a row On track merely because
       its historical daily rate projected well, even when its visible target,
       output, and deadline indicated otherwise. */
    /* There is no separate actual-completion-date input, so reaching the
       target is treated as delivered on time. */
    if (done) { bucket = "Delivered on time"; rank = 5; }
    else if (days !== null && days < 0) { bucket = "Overdue"; rank = 0; }
    else if (days !== null && days <= 3) { bucket = "Critical"; rank = 1; }
    else { bucket = "On track"; rank = 3; }

    /* Overdue outranks everything, and within it the whole balance still to
       collect is the weight — a deadline already missed puts the full amount at
       risk. Elsewhere the weight is the share of target still outstanding,
       tightened by how far short the crew's rate falls. */
    const urgency = days === null ? 1 : days < 0 ? 2.2 : days <= 30 ? 1.6 : days <= 90 ? 1.2 : 1;
    const shortfall = progress !== null && progress < 1 ? 1 - progress
      : (days !== null && days < 0 && !done ? 0.25 : 0);
    const paceDrag = pace !== null && pace < 1 ? 1 + (1 - pace) : 1;
    const score = bucket === "Overdue"
      ? (r.bal || 0) * urgency
      : shortfall * (r.bal || 0) * urgency * paceDrag;

    tracked.push({ ...r, target, actual, gap, remaining, progress, days, elapsed,
                   capacity, canDeliver, needRate, pace, bucket, rank, score, done });
  });
  return tracked.sort((a, b) => a.rank - b.rank || b.score - a.score);
}

const BUCKET_COLOR = {
  "Overdue": T.bad, "Critical": "#D2A21C", "Behind target": T.retention,
  "On track": T.collected, "Delivered on time": T.collected, "Delivered late": T.inkFaint,
};

/* the two standings that demand action are filled rather than outlined, so they
   carry across a room; everything else stays a quiet outline */
const BUCKET_PILL = {
  "Overdue":  { bg: T.bad,     fg: "#FFFFFF", bd: T.bad,     weight: 700 },
  "Critical": { bg: "#F0CB45", fg: T.ink,     bd: "#C79E1E", weight: 700 },
};
/* every standing renders at the same size so the column reads as one control,
   sized to the longest label ("Delivered on time") */
const PILL_BASE = {
  display: "inline-block", width: 112, textAlign: "center", padding: "2px 6px",
  borderRadius: 999, fontSize: 10, lineHeight: "13px", whiteSpace: "nowrap",
};
const pillStyle = (b) => {
  const s = BUCKET_PILL[b];
  return s
    ? { ...PILL_BASE, background: s.bg, color: s.fg, border: `1px solid ${s.bd}`, fontWeight: s.weight }
    : { ...PILL_BASE, background: "transparent", color: BUCKET_COLOR[b], border: `1px solid ${BUCKET_COLOR[b]}`, fontWeight: 500 };
};

function TargetAnalysis({ rows }) {
  const tracked = useMemo(() => assessTargets(rows), [rows]);

  if (tracked.length === 0) {
    return (
      <Panel title="Target tracking and priority">
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint, lineHeight: 1.7 }}>
          No targets set yet.<br />
          Fill in <b>Target qty</b> or <b>Target completion</b> on any row above and it will appear here.
        </div>
      </Panel>
    );
  }

  const buckets = ["Overdue", "Critical", "Behind target", "On track", "Delivered on time", "Delivered late"];
  const counts = {};
  buckets.forEach((b) => (counts[b] = tracked.filter((t) => t.bucket === b)));

  const atRisk = tracked.filter((t) => ["Overdue", "Critical", "Behind target"].includes(t.bucket));
  const notAchieved = tracked.filter((t) => !t.done);
  const atRiskMoney = sum(atRisk, "bal");
  /* action items first; targets already met on time are listed underneath as a
     record of what has landed, and never carry a priority weight */
  const actionItems = tracked.filter((t) => t.rank <= 2).slice(0, 10);
  const onTrack = tracked.filter((t) => t.bucket === "On track").slice(0, 8);
  const achieved = tracked.filter((t) => t.bucket === "Delivered on time")
    .sort((a, b) => (b.bal || 0) - (a.bal || 0)).slice(0, 8);
  const priority = [...actionItems, ...onTrack, ...achieved];
  /* normalise the bar inside each bucket — otherwise one huge overdue project
     flattens every critical bar to a sliver */
  const bucketMax = {};
  priority.forEach((p) => { bucketMax[p.bucket] = Math.max(bucketMax[p.bucket] || 1, p.score); });

  return (
    <Panel title="Target tracking and priority" right={
      <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
        {tracked.length} of {rows.length} projects have targets
      </span>
    }>
      {/* headline numbers */}
      <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Kpi label="Projects with target" value={tracked.length}
             meta={`of ${rows.length} shown`} />
        <Kpi label="Achieved on time" value={counts["Delivered on time"].length} color={T.collected}
             meta={counts["Delivered late"].length ? `${counts["Delivered late"].length} delivered late` : "none late"} />
        <Kpi label="Not yet achieved" value={notAchieved.length}
             meta={`${counts["Overdue"].length} overdue · ${counts["Critical"].length + counts["Behind target"].length} behind · ${counts["On track"].length} on track`} />
        <Kpi label="Overdue targets" value={counts["Overdue"].length} color={T.bad}
             meta="past completion date" />
        <Kpi label="Collection at risk" value={compact(atRiskMoney)} color={T.works} meta={money(atRiskMoney)} />
      </div>

      {/* how the tracked set splits */}
      <div className="mb-1 text-[10px] uppercase tracking-widest"
           style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>Where they stand</div>
      <div className="mb-3 flex h-6 overflow-hidden" style={{ border: `1px solid ${T.ink}`, background: T.paper2 }}>
        {buckets.map((b) => counts[b].length ? (
          <div key={b} title={`${b} — ${counts[b].length} project${counts[b].length === 1 ? "" : "s"}`}
               style={{ width: (counts[b].length / tracked.length) * 100 + "%", background: BUCKET_COLOR[b] }} />
        ) : null)}
      </div>
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: T.inkSoft }}>
        {buckets.map((b) => counts[b].length ? (
          <span key={b}>
            <span className="mr-1.5 inline-block h-2.5 w-2.5 align-[-1px]" style={{ background: BUCKET_COLOR[b] }} />
            {b} <b style={{ fontFamily: MONO, color: T.ink }}>{counts[b].length}</b>
          </span>
        ) : null)}
      </div>

      {/* the ranked worklist */}
      <div className="mb-1.5 text-[10px] uppercase tracking-widest"
           style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>
        Work these first — on-track and completed projects are listed underneath
      </div>
      <div className="overflow-x-auto">
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 11.5 }}>
          <thead>
            <tr>
              {[["#"], ["Project"], ["District / engineer"], ["Standing"], ["Target qty", "right"],
                ["Actual", "right"], ["Done", "right"], ["Pace", "right"], ["Due"], ["Remarks"],
                ["Balance to collect", "right"], ["Priority"]].map(([hd, al]) => (
                <th key={hd} style={{ textAlign: al || "left", padding: "5px 8px",
                                      borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 9.5,
                                      textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap" }}>{hd}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {priority.map((p, i) => (
              <tr key={p.id} style={p.done || p.bucket === "On track" ? { background: "#F7FAF6" } : undefined}>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, color: T.inkFaint }}>
                  {p.done ? "\u2713" : p.bucket === "On track" ? "—" : i + 1}</td>
                <td title={p.name} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap" }}>{p.id}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.district} · <span style={{ color: T.inkSoft }}>{p.engineer}</span>
                </td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}>
                  <span style={pillStyle(p.bucket)}>{p.bucket}</span>
                </td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right" }}>
                  {qty(p.target)}{p.unit ? <span style={{ color: T.inkFaint }}> {p.unit}</span> : null}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right" }}>
                  {qty(p.actual)}{p.unit ? <span style={{ color: T.inkFaint }}> {p.unit}</span> : null}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right",
                             color: p.progress !== null && p.progress < 1 ? T.bad : T.collected }}>
                  {p.progress === null ? "—" : (p.progress * 100).toFixed(0) + "%"}</td>
                <td title={p.capacity === null
                    ? "Set a start date to measure the daily rate"
                    : `${qty(p.capacity.toFixed(2))} ${p.unit || "units"}/day achieved · ${qty((p.needRate || 0).toFixed(2))} needed · ${qty(Math.round(p.canDeliver))} deliverable in ${p.days} days vs ${qty(p.remaining)} outstanding`}
                    style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right",
                             color: p.pace === null ? T.inkFaint : p.pace < 1 ? T.bad : T.collected }}>
                  {p.pace === null ? "—" : p.pace.toFixed(2) + "\u00D7"}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, whiteSpace: "nowrap",
                             color: p.days !== null && p.days < 0 ? T.bad : T.inkSoft }}>
                  {p.due ? fmtDate(p.due) : "—"}
                  {p.days !== null && (
                    <span style={{ color: T.inkFaint }}> · {p.days < 0 ? Math.abs(p.days) + "d late" : p.days + "d left"}</span>
                  )}
                </td>
                <td title={p.note || ""} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`,
                             maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                             color: p.note ? T.ink : T.inkFaint }}>
                  {p.note || "—"}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right", whiteSpace: "nowrap" }}>
                  {money(p.bal || 0)}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, width: 90 }}>
                  {p.done || p.bucket === "On track" ? (
                    <span style={{ fontFamily: MONO, fontSize: 10, color: T.inkFaint }}>—</span>
                  ) : (
                    <span className="block h-2" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
                      <span className="block h-full" style={{ width: (p.score / bucketMax[p.bucket]) * 100 + "%", background: BUCKET_COLOR[p.bucket] }} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint, lineHeight: 1.6 }}>
        On track means the target completion date is more than three days away and the target has not yet been reached.
        Critical means the deadline is within three days; overdue means the deadline has passed. A project is delivered
        on time when Actual output reaches Target qty. Priority ranks overdue and critical projects first.
      </div>
    </Panel>
  );
}

function PasswordChangePanel({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError("");
    if (password.length < 2) return setError("Password must be at least 2 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    const { error: passwordError } = await supabase.auth.updateUser({ password });
    if (!passwordError) {
      const { error: profileError } = await supabase.rpc("complete_password_change");
      if (profileError) setError(profileError.message); else onDone();
    } else setError(passwordError.message);
    setBusy(false);
  };
  const field = { width: "100%", padding: "9px 11px", fontFamily: MONO, fontSize: 13, color: T.ink,
    background: T.paper2, border: `1px solid ${T.rule}`, borderRadius: 2, outline: "none" };
  return <div style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,33,28,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <form onSubmit={submit} style={{ width: "min(420px,100%)", background: T.panel, padding: 22, border: `1px solid ${T.ink}` }}>
      <h2 style={{ fontFamily: DISPLAY, fontSize: 14, textTransform: "uppercase" }}>Change temporary password</h2>
      <p style={{ fontSize: 12, color: T.inkSoft }}>An administrator assigned a temporary password. Choose a private password to continue.</p>
      <input aria-label="New password" type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...field, marginTop: 12 }} />
      <input aria-label="Confirm password" type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ ...field, marginTop: 8 }} />
      {error && <div role="alert" style={{ marginTop: 10, color: T.bad, fontSize: 12 }}>{error}</div>}
      <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 14, padding: 10, border: 0, background: T.ink, color: T.paper2, fontFamily: DISPLAY, fontWeight: 700 }}>{busy ? "Saving…" : "Change password"}</button>
    </form>
  </div>;
}

function AdminPanel({ onClose }) {
  const [users, setUsers] = useState([]);
  const [temporary, setTemporary] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const call = async (body) => {
    setBusy(true); setMessage("");
    const { data, error } = await supabase.functions.invoke("admin-users", { body });
    setBusy(false);
    if (error || data?.error) { setMessage(error?.message || data.error); return null; }
    return data;
  };
  const load = async () => { const data = await call({ action: "list" }); if (data) setUsers(data.users || []); };
  useEffect(() => {
    let alive = true;
    supabase.functions.invoke("admin-users", { body: { action: "list" } }).then(({ data, error }) => {
      if (!alive) return;
      setBusy(false);
      if (error || data?.error) setMessage(error?.message || data.error);
      else setUsers(data?.users || []);
    });
    return () => { alive = false; };
  }, []);
  const resetPassword = async (id) => {
    const value = temporary[id] || "";
    if (value.length < 2) { setMessage("Enter a temporary password with at least 2 characters."); return; }
    const data = await call({ action: "reset-password", user_id: id, temporary_password: value });
    if (data) { setMessage("Temporary password assigned. The user must change it after login."); setTemporary((p) => ({ ...p, [id]: "" })); await load(); }
  };
  const toggleBan = async (u) => { const data = await call({ action: u.banned_until ? "unban" : "ban", user_id: u.id }); if (data) await load(); };
  return <div style={{ position: "fixed", inset: 0, zIndex: 25, background: "rgba(22,33,28,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <div style={{ width: "min(1000px,100%)", maxHeight: "85vh", overflow: "auto", background: T.panel, border: `1px solid ${T.ink}` }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 14, textTransform: "uppercase" }}>User management</h2>
        <button type="button" onClick={onClose} style={{ border: `1px solid ${T.rule}`, background: T.paper2, padding: "3px 8px" }}>×</button>
      </div>
      <div style={{ padding: 16 }}>
        {message && <div role="status" style={{ marginBottom: 10, color: message.includes("error") || message.includes("required") ? T.bad : T.inkSoft, fontSize: 12 }}>{message}</div>}
        <div className="overflow-auto"><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr>{["Username", "Email", "Role", "Status", "Temporary password", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 7px", borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
          <tbody>{users.map((u) => <tr key={u.id}>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO }}>{u.username || "—"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}>{u.email || "—"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}>{u.role}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, color: u.banned_until ? T.bad : T.collected }}>{u.banned_until ? "Blocked" : "Active"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}><input type="password" placeholder="2+ characters" value={temporary[u.id] || ""} onChange={(e) => setTemporary((p) => ({ ...p, [u.id]: e.target.value }))} style={{ width: 150, padding: "4px 6px", border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 11 }} /></td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}><button type="button" disabled={busy} onClick={() => resetPassword(u.id)} style={{ marginRight: 6, padding: "4px 7px", border: `1px solid ${T.rule}`, background: T.paper2, fontSize: 11 }}>Reset</button><button type="button" disabled={busy} onClick={() => toggleBan(u)} style={{ padding: "4px 7px", border: `1px solid ${u.banned_until ? T.collected : T.bad}`, background: T.paper2, color: u.banned_until ? T.collected : T.bad, fontSize: 11 }}>{u.banned_until ? "Unblock" : "Block"}</button></td>
          </tr>)}</tbody>
        </table></div>
      </div>
    </div>
  </div>;
}

/* ---------------- app ---------------- */

export default function ProjectLedger({ user, onSignOut }) {
  const [store, setStore] = useState(() => snapshotState());
  const [sourceLabel, setSourceLabel] = useState(SNAPSHOT_LABEL);
  const [imported, setImported] = useState(false);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const [manual, setManual] = useState({});
  const [manualReady, setManualReady] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [savingIds, setSavingIds] = useState(new Set());
  const [saveMessage, setSaveMessage] = useState("");
  const [username, setUsername] = useState(user?.user_metadata?.username || user?.email || "Unknown user");
  const [role, setRole] = useState("user");
  const [forcePasswordChange, setForcePasswordChange] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [auditTarget, setAuditTarget] = useState(null);

  useEffect(() => {
    let alive = true;
    loadManual().then((m) => {
      if (alive) { setManual(m); setManualReady(true); }
    }).catch((error) => {
      if (alive) { setManualReady(true); setSaveMessage(`Could not load saved project updates: ${error.message}`); }
    });
    if (isConfigured && supabase && user?.id) {
      supabase.from("profiles").select("username, role, force_password_change").eq("id", user.id).maybeSingle()
        .then(({ data }) => { if (!alive || !data) return; if (data.username) setUsername(data.username); setRole(data.role || "user"); setForcePasswordChange(Boolean(data.force_password_change)); });
    }
    return () => { alive = false; };
  }, [user]);

  const editManual = (id, field, value) =>
    setDrafts((prev) => {
      const row = { ...(prev[id] || {}) };
      row[field] = value;
      const next = { ...prev };
      next[id] = row;
      return next;
    });

  const dirtyIds = useMemo(() => new Set(Object.keys(drafts)), [drafts]);
  const dirtyCount = useMemo(() => Object.values(drafts)
    .reduce((count, row) => count + Object.keys(row).length, 0), [drafts]);

  const saveRow = async (id) => {
    if (!drafts[id] || savingIds.has(id)) return;
    const values = { ...(manual[id] || {}), ...drafts[id] };
    setSavingIds((prev) => new Set(prev).add(id));
    setSaveMessage("");
    try {
      await saveManualRow(id, values, manual[id], user?.id, username);
      setManual((prev) => ({ ...prev, [id]: values }));
      setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setSaveMessage(`Saved changes for ${id}.`);
    } catch (error) {
      setSaveMessage(`Could not save ${id}: ${error.message}`);
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const saveAll = async () => {
    const ids = [...dirtyIds];
    for (const id of ids) await saveRow(id);
  };

  const [filters, setFilters] = useState(() => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); return o; });
  const [q, setQ] = useState("");
  const [groupBy, setGroupBy] = useState("district");
  const [sort, setSort] = useState({ key: "bal", dir: -1 });

  const importedRows = useMemo(() => assemble(store.coll, store.dim), [store]);
  /* imported columns and hand-typed columns are merged only at render time — an
     import rebuilds `importedRows` and never touches `manual` */
  const records = useMemo(() => importedRows.map((r) => {
    const m = manual[r.id];
    const draft = drafts[r.id];
    const merged = m || draft ? { ...r, ...(m || {}), ...(draft || {}) } : { ...r };
    const set = (x) => x !== undefined && x !== null && x !== "";
    merged.hasTarget = set(merged.target) || set(merged.due) ? "With target" : "No target";
    if ((m?.note || draft?.note)) merged._hay = r._hay + " " + (merged.note || "").toLowerCase();
    return merged;
  }), [importedRows, manual, drafts]);

  const handleFiles = async (files) => {
    setBusy(true);
    const out = [];
    let coll = store.coll, dim = store.dim, gotColl = false, gotMaster = false;
    for (const f of files) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const names = wb.SheetNames.map(NORM);
        const isColl = names.some((n) => n.includes("COLLECTIBLE"));
        const isMaster = names.some((n) => n.includes("QMB PROJECT") || n.includes("QM LICENSE"));
        out.push({ text: `${f.name} — ${wb.SheetNames.length} sheets` });
        if (isColl) {
          const r = readCollectibles(wb);
          out.push(...r.log);
          if (r.rows && r.rows.length) { coll = r.rows; gotColl = true; }
        } else if (isMaster) {
          const r = readMaster(wb);
          out.push(...r.log);
          if (r.dim.size) { dim = r.dim; gotMaster = true; }
        } else {
          out.push({ warn: true, text: `${f.name}: no Collectibles / QMB Projects / QM Licenses sheet — skipped` });
        }
      } catch (err) {
        out.push({ warn: true, text: `${f.name}: could not be read (${err.message})` });
      }
    }
    if (gotColl || gotMaster) {
      const matched = coll.filter((m) => dim.has(m.key)).length;
      out.push({ text: `Joined: ${matched} of ${coll.length} projects matched to master attributes` });
      if (matched < coll.length)
        out.push({ warn: true, text: `${coll.length - matched} project IDs not found in QMB Projects / QM Licenses — shown as UNSPECIFIED` });
      setStore({ coll, dim });
      setImported(true);
      const parts = [];
      if (gotColl) parts.push("collectibles");
      if (gotMaster) parts.push("master");
      setSourceLabel(`Imported ${parts.join(" + ")} · ${files.map((f) => f.name).join(", ")}`);
    }
    setLog(out);
    setBusy(false);
  };

  const reset = () => {
    setStore(snapshotState());
    setSourceLabel(SNAPSHOT_LABEL);
    setImported(false);
    setLog([]);
  };

  const query = q.trim().toLowerCase();
  const passes = (r, skip) => {
    for (const d of DIMS) {
      if (d.k === skip) continue;
      const s = filters[d.k];
      if (s.size && !s.has(r[d.k])) return false;
    }
    if (query && !r._hay.includes(query)) return false;
    return true;
  };
  const rows = records.filter((r) => passes(r, null));

  const countsFor = (dimKey) => {
    const m = new Map();
    records.forEach((r) => m.set(r[dimKey], 0));
    records.forEach((r) => { if (passes(r, dimKey)) m.set(r[dimKey], m.get(r[dimKey]) + 1); });
    return m;
  };

  const toggle = (dimKey, value) => setFilters((prev) => {
    const s = new Set(prev[dimKey]);
    s.has(value) ? s.delete(value) : s.add(value);
    return { ...prev, [dimKey]: s };
  });
  const clearOne = (dimKey) => setFilters((prev) => ({ ...prev, [dimKey]: new Set() }));
  const clearAll = () => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); setFilters(o); setQ(""); };
  const onSort = (k) => setSort((s) => (s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: -1 }));

  const exportCsv = (data) => {
    const qq = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [EXPORT_COLS.map((c) => qq(c.label)).join(",")];
    data.forEach((r) => lines.push(EXPORT_COLS.map((c) => qq(r[c.k])).join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = "project-collectibles-filtered.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  const contract = sum(rows, "contract"), gross = sum(rows, "gross"), net = sum(rows, "net");
  const cg = sum(rows, "cg"), cc = sum(rows, "cc"), cr = sum(rows, "cr");
  const bal = sum(rows, "bal"), netbal = sum(rows, "netbal");
  const other = Math.max(0, contract - gross - cg);
  const activeSegs = DIMS.filter((d) => filters[d.k].size);
  const anyActive = activeSegs.length > 0 || query.length > 0;

  return (
    <div style={{
      background: T.paper, color: T.ink, fontFamily: BODY, fontSize: 14, minHeight: "100vh",
      backgroundImage: `linear-gradient(${T.ruleSoft} 1px,transparent 1px),linear-gradient(90deg,${T.ruleSoft} 1px,transparent 1px)`,
      backgroundSize: "28px 28px", backgroundPosition: "-1px -1px",
    }}>
      <style dangerouslySetInnerHTML={{ __html:
        `@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');` }} />

      <div className="mx-auto max-w-[1480px] px-4 pb-16">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4 pt-5 pb-3" style={{ borderBottom: `2px solid ${T.ink}` }}>
          <div>
            <h1 className="text-2xl uppercase" style={{ fontFamily: DISPLAY, fontWeight: 800, letterSpacing: ".045em" }}>Project Ledger</h1>
            <div className="mt-1 text-xs" style={{ color: T.inkSoft }}>
              Filter by district, license, senior engineer, category, location — read collectibles,
              balance for collection, balance works and status.
            </div>
          </div>
          <div className="flex items-end gap-4 text-right text-[11px] leading-relaxed" style={{ fontFamily: MONO, color: T.inkSoft }}>
            <div>
              {records.length} projects loaded<br />
              master from QMB Projects + QM Licenses
            </div>
            {role === "admin" && <button type="button" onClick={() => setAdminOpen(true)}
              style={{ color: T.ink, background: T.paper2, border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 10, padding: "5px 7px", cursor: "pointer" }}>
              User management
            </button>}
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="px-2 py-1 uppercase"
                style={{
                  color: T.ink,
                  background: T.paper2,
                  border: `1px solid ${T.rule}`,
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: ".08em",
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <ImportPanel onLoad={handleFiles} sourceLabel={sourceLabel} log={log} busy={busy}
                     onReset={reset} canReset={imported} />

        <FilterBar q={q} setQ={setQ} filters={filters} countsFor={countsFor}
                   onToggle={toggle} onClearOne={clearOne} onClearAll={clearAll} anyActive={anyActive} />

        <div className="mb-4 flex flex-wrap items-baseline gap-2 px-3 py-2"
             style={{ background: T.paper2, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.ink}`,
                      fontFamily: MONO, fontSize: 12, color: T.inkSoft }}>
          <span><b style={{ color: T.ink }}>{rows.length}</b> of {records.length} projects</span>
          {activeSegs.length === 0 && !query && <span style={{ color: T.inkFaint }}>› no filters applied</span>}
          {activeSegs.map((d) => (
            <span key={d.k}>
              <span style={{ color: T.inkFaint }}>› </span>{d.label}:{" "}
              <b style={{ color: T.ink }}>{filters[d.k].size <= 2 ? [...filters[d.k]].join(", ") : filters[d.k].size + " selected"}</b>
            </span>
          ))}
          {query && <span><span style={{ color: T.inkFaint }}>› </span>search: <b style={{ color: T.ink }}>{query}</b></span>}
        </div>

        <div>
            <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(168px,1fr))" }}>
              <Kpi label="Projects" value={rows.length} meta={`of ${records.length}`} />
              <Kpi label="Contract amount" value={compact(contract)} meta={money(contract)} />
              <Kpi label="Collected (net)" value={compact(net)} color={T.collected}
                   meta={contract ? pct(net / contract) + " of contract" : "—"} />
              <Kpi label="Balance for collection" value={compact(bal)} color={T.works} meta={`net ${compact(netbal)}`} />
              <Kpi label="Balance works" value={compact(cg)} color={T.works}
                   meta={contract ? pct(cg / contract) + " of contract" : "—"} />
              <Kpi label="Retention held" value={compact(cr)} color={T.retention} meta={money(cr)} />
            </div>


            <div className="grid gap-3" style={{ gridTemplateColumns: "7fr 3fr", alignItems: "stretch" }}>
              <Panel title="Where the money sits">
                <Meter label="Contract amount — billed vs works still to do"
                  segments={[
                    { label: "Billed gross", value: gross, color: T.collected },
                    { label: "Balance works", value: cg, color: T.works },
                    { label: "Unaccounted", value: other, color: T.ruleSoft },
                  ]}
                  legend={[
                    { color: T.collected, label: "Billed gross", value: money(gross), extra: pct(contract ? gross / contract : null) },
                    { color: T.works, label: "Balance works", value: money(cg), extra: pct(contract ? cg / contract : null) },
                    { label: "Contract", value: money(contract) },
                  ]} />
                <div style={{ flex: 1, minHeight: 16 }} />
                <Meter label="Balance for collection — what it is made of"
                  segments={[
                    { label: "Unbilled works", value: cg, color: T.works },
                    { label: "Cash balance", value: cc, color: T.cash },
                    { label: "Retention", value: cr, color: T.retention },
                  ]}
                  legend={[
                    { color: T.works, label: "Unbilled works", value: money(cg) },
                    { color: T.cash, label: "Cash balance", value: money(cc) },
                    { color: T.retention, label: "Retention", value: money(cr) },
                    { label: "Total", value: money(bal), extra: "net " + money(netbal) },
                  ]} />
              </Panel>
              <StatusChart rows={rows} />
            </div>

            <div style={{ marginTop: 18 }}>
              <GroupChart rows={rows} groupBy={groupBy} onGroupBy={setGroupBy} />
            </div>

            {(!manualReady || saveMessage) && (
              <div className="mb-2 px-3 py-2 text-xs" role={saveMessage.startsWith("Could") ? "alert" : undefined}
                   style={{ color: saveMessage.startsWith("Could") ? T.bad : T.inkSoft,
                            background: saveMessage.startsWith("Could") ? "#FBEEEC" : T.paper2,
                            border: `1px solid ${saveMessage.startsWith("Could") ? T.bad + "55" : T.rule}` }}>
                {manualReady ? saveMessage : "Loading saved project updates…"}
              </div>
            )}
            <LedgerTable rows={rows} sort={sort} onSort={onSort} onExport={exportCsv} onEdit={editManual}
                         onSaveRow={saveRow} onSaveAll={saveAll} dirtyIds={dirtyIds} dirtyCount={dirtyCount}
                         savingIds={savingIds} onAuditCell={setAuditTarget} />

            <TargetAnalysis rows={rows} />
            {auditTarget && <AuditModal key={`${auditTarget.projectId}:${auditTarget.field}`} target={auditTarget}
                                        onClose={() => setAuditTarget(null)} />}
            {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
            {forcePasswordChange && <PasswordChangePanel onDone={() => setForcePasswordChange(false)} />}
        </div>
      </div>
    </div>
  );
}
