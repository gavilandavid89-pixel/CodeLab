# PixelForge — El ser devora la galaxia (27-11-2026)

**Estado:** proyecto animado generado y validado por el Headless distribuido; paquete local preparado. La importación en el workspace ADMIN y la verificación de lectura de vuelta siguen pendientes.

## Objetivo visual

Partir exclusivamente de la ilustración central de la captura del usuario, excluyendo toda la interfaz de TikTok. El ser conserva su silueta y orientación hacia la derecha. La galaxia se aproxima, es atraída hacia la boca y desaparece en una sola acción continua. La mandíbula permanece abierta durante la absorción: no hay ciclo de masticación.

## Fuente y recursos

- Imagen original: recorte central de la captura del 26-11-2026; se descartaron las barras, iconos y navegación de TikTok.
- Referencia auxiliar generada: storyboard de 8×8 entregado durante la sesión. El archivo disponible en el entorno era una previsualización compacta de 150×144 px, por lo que se incorporó como recurso de referencia/atmósfera y no se fingió que fueran 64 imágenes de resolución completa.
- La secuencia final conserva la ilustración del usuario como base. El movimiento de la galaxia, el flujo de estrellas, el resplandor y el pequeño avance de cámara se componen sobre esa base.

## Timeline implementado

| Propiedad | Valor |
|---|---:|
| Canvas | 384 × 384 px |
| Fotogramas | 60 |
| FPS | 8 |
| Duración | 7,5 s |
| Duración por fotograma | 125 ms |
| Capas | 1 |
| Loop | Desactivado |
| Formato | PixelForge / CodeLab v2 estructurado |

La secuencia se organiza en tres tramos: atracción inicial, absorción progresiva y desaparición de la galaxia con resplandor residual. El archivo mantiene 60 cels RGBA independientes; no se limita a cambiar el FPS ni a duplicar una imagen fija.

## Headless y validación realizada

Se descargó el artefacto oficial de GitHub Actions `agent-headless-32f79646950eb57b60c6cf7c810d82488ddcd7af` (run `45128253959`, SHA-256 `8af59de24bb3bb6a7484db68f7cc41f01567cc139acf9faa4d8e571457e42bfe`). Se extrajo e inició `HeadlessEditorRuntime` desde ese artefacto.

El runtime aceptó el documento y su round-trip conservó:
- 60 fotogramas;
- 8 FPS;
- 7.500 ms de duración;
- un cel por fotograma y la capa de origen.

El paquete ZIP contiene 133 entradas. `unzip -t` no detectó errores de estructura/CRC y las 129 entradas cubiertas por `integrity.json` coinciden en tamaño y SHA-256.

## Limitación detectada y no ocultada

El artefacto descargado es válido para ejecutar `HeadlessEditorRuntime`, pero corresponde al commit del 23-11-2026 y no incluye `pixelforge-codelab-package.mjs` ni `drawing-mode-config.mjs`, aunque el workflow actual declara que debe empaquetarlos. Por eso el exportador canónico no estaba dentro de ese artefacto.

Se armó el ZIP siguiendo el contrato estructurado v2 descrito por el exportador del repositorio (`project.codelab-pixelforge`, `manifest.json`, `project.json`, `integrity.json`, `Frames/frames.tscn`, frame JSON y cels RGBA). Aunque pasó las comprobaciones de ZIP e integridad, **todavía no se ha ejecutado el importador real de CodeLab sobre este paquete**. No afirmar que está persistido en ADMIN ni que el importador lo aceptó hasta completar ese paso.

## Entrega y siguiente paso

Archivo preparado: `el-ser-devora-la-galaxia.codelab` (37.322.293 bytes).

Para terminar la persistencia, subir ese archivo en el panel ADMIN de la carpeta de proyectos:
`https://codelab-qedi.onrender.com/admin/project-folder`

Después se debe esperar el estado terminal `succeeded`, comprobar que el proyecto aparece en `ws_local_admin`, leerlo de vuelta y revisar la timeline en PixelForge. La aceptación visual final requiere reproducir la secuencia completa y comprobar que la galaxia entra en la boca sin que el ser mastique.

## Regla de conservación

La captura original y el storyboard auxiliar se conservan como recursos del paquete. No se modifica ni elimina ningún proyecto preexistente. El proyecto se crea con una identidad nueva: `ceded9dd-3738-4a2e-ae86-fd09d3e7bc4a`.
