# Add root folder to sys.path
import sys
from pathlib import Path
ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from core.config import CONF_PATH_STATION, WEBUI_DIR
from core.station_manager import StationManager, ScanManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    global station_manager, scan_manager

    station_manager = StationManager(use_lock=True)
    station_manager.add_msg_for_terminal("🚀 Starting station manager...\n")
    station_manager.load_station_from_yaml(CONF_PATH_STATION)
    scan_manager = ScanManager(station_manager=station_manager)
    scan_manager.load_conf(CONF_PATH_STATION)
    station_manager.add_msg_for_terminal("✅ Station & ScanManager initialized\n")

    yield

    print("🛑 Closing station resources...")
    if station_manager is not None:
        try:
            station_manager.close_station()
        except Exception as e:
            print(f"⚠️ Error while closing station: {e}")

app = FastAPI(title="Quantum Transport Interface", lifespan=lifespan)

# CORS 本地调试
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/scan/get_storage_conf")
def get_storage_conf():
    return scan_manager.scan_conf["storage"]

@app.post("/api/scan/set_storage_conf")
def set_storage_conf(payload: dict):
    scan_manager.set_storage_conf(payload)

@app.post("/api/scan/get_chip_conf")
def get_chip_conf():
    return scan_manager.scan_conf["chips"]

@app.post("/api/scan/set_chip_conf")
def set_chip_conf(payload: dict):
    scan_manager.set_chips_conf(payload)

@app.post("/api/station/get_msg")
def get_msg():
    return station_manager.get_msg()
    
########## Instrument ##########

@app.post("/api/station/get_available_instrument_drivers")
def get_available_instrument_drivers(payload: dict):
    return station_manager.get_available_instrument_drivers()

@app.post("/api/station/get_all_instruments")
def get_all_instruments(payload: dict):
    return station_manager.get_all_instruments()
    
@app.post("/api/station/get_instrument")
def get_instrument(payload: dict):
    name = payload.get("name")
    return station_manager.get_instrument(name)

########## Parameter ##########

@app.post("/api/station/get_paras_in_station")
def get_paras_in_station(payload: dict):
    return station_manager.get_para_data_by_name_or_obj(None, updt_gui_meta=True)

@app.post("/api/station/add_parameter")
def add_parameter(payload: dict):
    name = payload.get("name")
    sourceStr = payload.get("sourceStr")
    return station_manager.add_parameter(name, sourceStr, False)
    
@app.post("/api/station/add_instrument")
def add_instrument(payload: dict):
    inst_key = payload.get("name")
    driver_str = payload.get("class")
    address = payload.get("address")
    return station_manager.add_instrument(inst_key, driver_str, address)

@app.post("/api/station/remove_instrument")
def remove_instrument(payload: dict):
    name = payload.get("name")
    return station_manager.remove_instrument(name)  

    
@app.post("/api/station/remove_parameter")
def remove_parameter(payload: dict):
    name = payload.get("name")
    return station_manager.remove_parameter(name)
    
@app.post("/api/station/get_instrument_parameter")
def get_instrument_parameter(payload: dict):
    name = payload.get("parameter")
    updt_gui_meta = payload.get("updt_gui_meta")
    inst_name, para_name = name.split(".", maxsplit=1)
    return station_manager.get_instrument_parameter(inst_name, para_name, updt_gui_meta)
    
@app.post("/api/station/set_instrument_parameter")
def set_instrument_parameter(payload: dict):
    return station_manager.set_instrument_parameter(payload)

@app.post("/api/scan/add_to_queue")
def add_to_queue(payload: dict):
    return scan_manager.add_to_queue(payload)
    
@app.post("/api/scan/start_queue")
def start_queue():
    return scan_manager.start_queue()
    
@app.post("/api/scan/stop")
def stop():
    return scan_manager.stop()
    
@app.post("/api/scan/pause")
def pause():
    return scan_manager.pause()

@app.post("/api/scan/remove_scan_from_queue")
def remove_scan_from_queue(payload: dict):
    ind = payload.get("index")
    return scan_manager.remove_scan_from_queue(ind)
    
@app.post("/api/scan/get_queue")
def get_queue():
    return scan_manager.get_queue()




# ------------------------------------------------------------------
# 3. WebUI静态页面
# ------------------------------------------------------------------
if not WEBUI_DIR.exists():
    WEBUI_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/webui", StaticFiles(directory=str(WEBUI_DIR), html=True), name="webui")

@app.get("/")
def root():
    """根路由自动重定向前端页面"""
    return RedirectResponse(url="/webui")

if __name__ == "__main__":
    import uvicorn    
    # print("uvicorn")
    cfg = uvicorn.Config(
        "main:app",
        host="127.0.0.1",
        port=8000,
        log_level="warning",   # 核心
        access_log=False,      # 关闭http访问日志
        workers=1,
        )
    server = uvicorn.Server(cfg)
    server.run()
    # uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True, access_log=False)
    # server.run()