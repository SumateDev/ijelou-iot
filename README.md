# MQTT API - Sonoff

API REST en Node.js/Express para gestionar dispositivos Sonoff (firmware Tasmota) a través de un broker MQTT (Mosquitto). La API se suscribe a los topics de estado y telemetría de los dispositivos, mantiene su último estado en memoria y expone endpoints para consultarlos y enviarles comandos.

## Características

- Conexión al broker MQTT con reintentos y backoff exponencial.
- Suscripción automática a los topics `stat/+/+` (estado) y `tele/+/+` (telemetría) de Tasmota.
- Cache en memoria del último estado reportado por cada dispositivo.
- Endpoints para consultar dispositivos, enviar comandos genéricos y controlar el encendido/apagado (`Power`).
- Autenticación de la API mediante Bearer Token (opcional).
- Documentación Swagger estática servida en `/docs` y `/ttlock-docs`.

## Requisitos

- Node.js 16+
- Un broker MQTT (Mosquitto) accesible desde la API
- Dispositivos Sonoff con firmware Tasmota publicando en los topics `stat/#` y `tele/#`

## Instalación

```bash
npm install
```

## Configuración

Copia `.env.example` a `.env` y ajusta los valores:

```bash
cp .env.example .env
```

| Variable             | Descripción                                             | Por defecto |
|----------------------|----------------------------------------------------------|-------------|
| `MQTT_HOST`          | Host del broker Mosquitto                                | `mosquitto` |
| `MQTT_PORT`          | Puerto del broker MQTT                                    | `1883`      |
| `MQTT_USERNAME`      | Usuario para autenticación MQTT (opcional)                | -           |
| `MQTT_PASSWORD`      | Contraseña para autenticación MQTT (opcional)              | -           |
| `API_BEARER_TOKEN`   | Token requerido en el header `Authorization` de la API. Si no se define, la autenticación queda deshabilitada (modo desarrollo) | - |
| `PORT`               | Puerto en el que escucha el servidor HTTP                 | `3000`      |

## Uso

```bash
node index.js
```

El servidor se levanta primero en el puerto configurado y luego intenta conectarse al broker MQTT (hasta 10 reintentos con backoff). Si la conexión MQTT falla, la API sigue disponible, pero los endpoints que dependen de MQTT responderán `503`.

## Autenticación

Si `API_BEARER_TOKEN` está definido, todas las rutas bajo `/api` (excepto `/api/health`) requieren el header:

```
Authorization: Bearer <API_BEARER_TOKEN>
```

## Endpoints

### `GET /api/health`
Verifica el estado del servicio (no requiere autenticación).

```json
{
  "status": "ok",
  "mqtt_connected": true,
  "mqtt_authenticated": false,
  "api_authentication_enabled": true,
  "uptime": 123.45,
  "timestamp": "2026-10-19T12:00:00.000Z"
}
```

### `GET /api/devices`
Devuelve el último estado conocido de todos los dispositivos.

### `GET /api/devices/:deviceName`
Devuelve el último estado conocido de un dispositivo específico.

### `POST /api/devices/:deviceName/command`
Publica un comando arbitrario en el topic `cmnd/:deviceName/:command`.

```json
{
  "command": "Status",
  "value": 0
}
```

### `POST /api/devices/:deviceName/power`
Controla el encendido/apagado publicando en `cmnd/:deviceName/Power`.

```json
{
  "state": "ON"
}
```

`state` acepta `ON`, `OFF` o `TOGGLE`.

### `GET /api/system/info`
Información sobre la conexión al broker MQTT y el estado general del sistema.

## Documentación Swagger

- `/docs` – documentación Swagger de la API.
- `/ttlock-docs` – documentación Swagger adicional (cerraduras).

## Estructura de topics MQTT

| Dirección          | Topic                        | Descripción                          |
|---------------------|-------------------------------|---------------------------------------|
| Dispositivo → API   | `stat/<device>/<tipo>`        | Respuestas de estado (RESULT, POWER…) |
| Dispositivo → API   | `tele/<device>/<tipo>`        | Telemetría periódica (STATE, SENSOR…) |
| API → Dispositivo   | `cmnd/<device>/<comando>`     | Comandos enviados al dispositivo      |
