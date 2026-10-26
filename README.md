# HydroGuard Mock API

Backend simulado multiempresa para probar localmente la aplicación web del Administrador y la aplicación Flutter del Operario. Persiste temporalmente en `mock-api/db.json` o en la copia indicada mediante `MOCK_DB_PATH`.

El bounded context de configuración operativa (BC-02) permite administrar grupos, reservorios, dispositivos, vinculaciones exclusivas y perfiles de Operario con asignaciones e historial. La creación de una cuenta continúa hacia su perfil y código de primer acceso. La web también consulta borradores, versiones publicadas y compatibilidad de configuraciones, sin editarlas.

La [guía unificada de pruebas manuales](docs/guia-pruebas-manuales-integrales.md) describe, paso a paso, todos los flujos disponibles, sus variantes, resultados esperados y limitaciones actuales.

Para comprender la solución también están disponibles:

- [Arquitectura, actores y flujos](docs/arquitectura-y-flujos-de-la-aplicacion.md).
- [Guía técnica de estructura, archivos y estados](docs/guia-tecnica-estructura-y-estados.md).

## Requisitos

- Node.js 22 LTS.
- npm 11.

## Instalación

```bash
npm install
```

## Ejecución local

Inicia el backend mock:

```bash
npm run mock:api
```

Comprueba su estado en `http://127.0.0.1:3000/`. Debe responder con `status: "UP"`. El puerto 3000 expone solamente la API; no contiene la interfaz gráfica.

En otra terminal, inicia Angular:

```bash
npm start
```

Abre `http://127.0.0.1:4200/`. Desde el acceso se puede registrar una empresa junto con su único administrador. Otras empresas también pueden registrarse y mantienen sus usuarios y recursos separados mediante `organizationId`.

Para Flutter, inicie el servidor con `HOST=0.0.0.0` y ejecute:

```powershell
flutter run --dart-define=HYDROGUARD_API_URL=http://10.0.2.2:3000/api/v1
```

El emulador Android usa `10.0.2.2` para acceder a la laptop. Un teléfono físico debe usar la IPv4 local de la laptop.

El frontend consume rutas `/api/v1`. Durante el desarrollo, [proxy.conf.json](proxy.conf.json) dirige `/api` hacia el mock local; en producción se conserva la misma ruta relativa para integrarse con el backend real.

## Despliegue académico

El despliegue de demostración separa los dos procesos:

- `vercel.json` compila Angular, publica `dist/hydroguard-admin-web-frontend/browser`, reenvía `/api/*` al mock y configura el fallback de Angular Router.
- `render.yaml` ejecuta el mock como un Web Service Node.js en Render.

Despliegue primero el Blueprint de Render y compruebe `/api/v1/health`. El servicio configurado se llama `hydroguard-mock-api-8740` y su dominio esperado es `https://hydroguard-mock-api-8740.onrender.com`.

El plan gratuito de Render utiliza almacenamiento efímero: un reinicio o nuevo despliegue devuelve el mock a la semilla de `db.json`. Esta configuración es adecuada para la demostración académica, no para almacenar datos reales.

El registro usa `POST /api/v1/organization-registrations`. Recibe los datos de la empresa —nombre, RUC, teléfono y un solo segmento— y los del administrador —nombre, correo y contraseña—. El acceso posterior usa el correo del administrador y su contraseña.

El mock persiste los registros en `mock-api/db.json`; las contraseñas visibles allí son únicamente datos locales de desarrollo. En el backend real, la creación de empresa y administrador debe ejecutarse en una sola transacción, el RUC y el correo deben tener restricciones únicas, la relación empresa-administrador debe garantizar uno a uno y la contraseña debe almacenarse mediante un hash seguro. La autorización del backend debe derivar siempre la empresa desde la sesión y nunca confiar en un `organizationId` enviado por el cliente.

### Cuentas de demostración

| Empresa                      | Segmento    | Correo                       | Contraseña         |
| :--------------------------- | :---------- | :--------------------------- | :----------------- |
| Textil San Juan S.A.C.       | Textil      | `admin.textil@hydroguard.pe` | `adminpassword123` |
| Hidroverde Pachacámac S.A.C. | Hidropónico | `admin.hidro@hydroguard.pe`  | `adminpassword123` |

Operarios:

| Caso | Identificador | Contraseña | Código |
|:--|:--|:--|:--|
| Login activo | `marcelino.valencia` | `operadorpassword123` | — |
| Primer acceso | `carlos.mendoza` | `operadorpassword123` | `HG-31Z8P9` |

Las rutas `/api/v1/operator/*` derivan perfil y asignaciones desde el token, impiden consultar dispositivos ajenos y cubren contexto, configuración, telemetría, Treatment, alertas e historial.

Cada cuenta administradora solo puede consultar y modificar los operarios y recursos operativos pertenecientes a su empresa.

## Comandos

```bash
npm start          # Servidor de desarrollo
npm run mock:api   # Backend mock basado en mock-api/db.json
npm run build      # Compilación de producción
npm run verify:bc02 # Verificación HTTP sobre una base temporal
npm run verify:bc04 # Verificación de Treatment
npm run verify:bc05 # Verificación de Monitoring
npm run verify:operator # Verificación integral de contratos móviles
```

## Estructura principal

- `src/app/iam`: bounded context de Identity and Access Management.
- `src/app/device-configuration`: bounded context de configuración operativa, separado por capas.
- `src/app/core`: infraestructura y layout compartidos por la aplicación.
- `src/app/shared`: componentes reutilizables.
- `mock-api`: servidor y datos para desarrollo local.
- `src/environments`: configuración de desarrollo y producción.

## Verificación

```bash
npm run build
npm run verify:bc02
npm run verify:bc04
npm run verify:bc05
```

La compilación se genera en `dist/`, directorio excluido del repositorio.
