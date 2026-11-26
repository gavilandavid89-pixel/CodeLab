# CodeLab — Branching Policy

## Regla única

**CodeLab se desarrolla siempre directamente sobre una única rama de trabajo: `main`.**

No se debe crear una rama permanente de feature, fix, test, integration o experimentación para continuar el desarrollo del producto.

Esto aplica independientemente del tamaño o tipo de trabajo:

- PixelForge / Illustration / Pixel.
- Editor y herramientas.
- Animation y Video Composer.
- Headless / Agent.
- Importación y exportación.
- Tests y regresiones.
- Documentación.
- Refactors.
- Correcciones urgentes.

### Flujo obligatorio

```text
main
  ↓
cambio
  ↓
verificación local/CI
  ↓
main
```

Cuando se necesite probar algo experimental, la prueba debe ejecutarse sobre el estado actual de `main` y sus resultados deben quedar registrados. No se crea otra rama permanente para conservar ese trabajo.

## Por qué

Mantener múltiples ramas de trabajo activas provocó divergencias de historial y ramas que quedaron cientos o miles de commits detrás de `main`. Eso dificulta saber qué código representa realmente el estado vigente de CodeLab y permite que agentes futuros trabajen accidentalmente sobre snapshots obsoletos.

**La fuente de verdad del código es `main`.**

Una rama antigua no debe tratarse como una versión alternativa válida de CodeLab solo porque todavía exista en GitHub.

## Política para agentes

Antes de modificar CodeLab:

1. Consultar `main`.
2. Confirmar el SHA actual de `main`.
3. Trabajar únicamente sobre `main`.
4. Verificar los cambios con los tests/workflows correspondientes.
5. Comprobar nuevamente el estado de `main` después de la verificación.
6. Documentar cualquier comportamiento importante que haya cambiado.

Si se encuentra una rama antigua:

- no continuar desarrollando sobre ella;
- comparar su trabajo exclusivo contra `main`;
- rescatar únicamente los cambios que sigan siendo necesarios;
- aplicar esos cambios sobre `main`;
- dejar la rama marcada como histórica/obsoleta y eliminarla cuando las herramientas de repositorio lo permitan.

## Ramas históricas

Las ramas que ya existen y están divergidas no representan el flujo futuro de trabajo. Pueden conservarse temporalmente únicamente para recuperar commits o revisar historial.

En particular, las ramas antiguas de pruebas de PixelForge detectadas durante la limpieza de noviembre de 2026 quedan consideradas **históricas**, no ramas de desarrollo activas.

Esto incluye las antiguas ramas de pruebas raster/browser y ramas auxiliares de tiled que ya fueron integradas o cuyo trabajo debe evaluarse directamente contra `main`.

## Regla para futuras tareas

Un agente **no debe crear otra rama porque el trabajo sea grande, porque necesite varios pasos o porque sea una prueba**.

Si el trabajo necesita varias etapas, esas etapas se realizan consecutivamente sobre `main`, verificando cada una antes de continuar.

Si una prueba falla, se corrige sobre `main` y se vuelve a verificar. No se crea una rama paralela para ocultar la divergencia.

## Estado de referencia

La referencia vigente debe ser siempre:

```
origin/main
```

La existencia de otras ramas en GitHub no cambia esta regla.

**Una sola línea de desarrollo. Una sola fuente de verdad. `main`.**
