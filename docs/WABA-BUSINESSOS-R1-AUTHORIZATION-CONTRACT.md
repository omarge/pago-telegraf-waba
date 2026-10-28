# KashBitPay WABA → BusinessOS Payment Authorization — integración candidata R1

## Contrato real verificado (solo lectura)
- BusinessOS: `omarge/businessos-payment-engine` `master`, controlador `payment-engine-app/src/main/java/com/businessos/payment/app/authorization/adapter/rest/PaymentAuthorizationController.java`.
- REST `POST /internal/v1/payment-authorizations`, solo registrado cuando `payment.authorization.inbound.enabled=true`. Requiere principal S2S autorizado por Security Engine (audience exacto `Payment`, permiso `payment.authorize`, scope TENANT).
- DTO: `PaymentAuthorizationRequest.java` y `PaymentAuthorizationResult.java`; el controlador responde 200 para AUTHORIZED, DECLINED, UNKNOWN, 409 para CONFLICT, 422 para PRE_EXECUTION_FAILED/DENIED y 401/403/503 por Security Engine.
- El `CardPaymentAuthorizationService` es dueño del idempotency guard y ejecución; el canal nunca fija provider account ni maneja guard/PSP.
- El contrato `businessos.integration.v1` del agregador permanece **de propiedad de Payment**. WABA no puede publicar `PaymentCaptured` ni inventar balance.

## Implementación en WABA
- `src/businessosAuthorizationAdapter.js`: construcción exacta de `PaymentAuthorizationRequest` desde solicitud WABA y **autoridad confiable inyectada**, con tenant/customer/medio de pago/Fraud APPROVE verificados. Monto MXN exacto decimal en cadena, IDs deterministas y misma clave de idempotencia para el mismo tenant+solicitud; sin tarjeta, NIP o tokens en body.
- `src/businessosAuthorizationTransport.js`: transporte HTTPS de **un solo POST** al endpoint real, token delegado desde servidor, sin redirect ni retry, timeout/lectura acotados. No se registra por defecto en el servidor WABA.
- `src/businessosChannelFlow.js`: frontera opt-in no montada en ninguna ruta HTTP; exige confirmación/CSRF, resuelve mapeos de autoridad confiable y evita doble clic por proceso. No actualiza estados locales, no cobra vía Openpay ni genera recibo financiero.
- El resultado `AUTHORIZED` se convierte **solamente** en `AUTHORIZED_PENDING_CAPTURE`, jamás PAID. UNKNOWN/5xx/timeouts/respuestas truncadas -> UNKNOWN_NO_RETRY, conciliación posterior a cargo del Payment Engine.

## PRECONDICIONES OBLIGATORIAS ANTES DE INTEGRAR EN EL RUNTIME
1. Acordar la identidad tenant y principal de servicio con BusinessOS Security Engine, permisos `Payment/payment.authorize` concedidos por la autoridad, nunca autootorgados en WABA.
2. Resolver `customerId` canónico y referencia de método de pago del vault de BusinessOS. **No** mandar el ID de tarjeta Openpay almacenada en el vault WABA; la referencia es opaque y debe validarse por el Payment Engine.
3. Obtener `fraudAssessmentId` + `fraudDecision=APPROVE` **de un verificador antifraude autorizado**. Nunca inventar APPROVE ni aceptar del navegador.
4. Definir y probar ciclo posterior de captura/completado: el contrato actual es únicamente **autorización**, no confirma captura ni liquidación. No se envían notificaciones 'Pago completado' por AUTHORIZED.
5. Implementar en el canal persistencia durable de los inputs/idempotency/UNKNOWN antes de permitir operación real; el guard de Map en pruebas no resiste reinicios.
6. Verificar canal HTTPS S2S, secretos por configuración privada y contratos reales de BusinessOS, con el Payment Engine certificado para GO (su gate actual histórico era NO_GO).
7. Autorizar explícitamente y con cambio independiente cualquier despliegue UAT, cargo o ejecución real. Ningún test de GitHub emite transacciones.

## Alcance certificado
**La rama contiene una integración técnica real del contrato HTTP y un adaptador HTTPS que puede ser inyectado, pero está DESACTIVADA y NO montada en el runtime del bot.** No se modificaron `src/index.js`, `src/formServer.js`, `src/savedCardFlow.js`, `src/accountRoutes.js` ni archivos `.env` reales. El Happy Path directo Sandbox sigue intacto en su rama existente. PR Draft contra la rama F09, nunca contra main.

BusinessOS y el agregador se inspeccionaron solo en lectura, sin commits ni cambios a master/main. Este PR no es certificación de integración económica ni de producción.
