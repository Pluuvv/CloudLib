package id.ac.upnvj.cloudlib;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

@QuarkusTest
public class ComputerReservationTest {

    private Long computerId;

    @BeforeEach
    @Transactional
    public void setupData() {
        ComputerReservation.deleteAll();
        Computer.deleteAll();
        Tenant.deleteAll();

        Tenant tenant = new Tenant();
        tenant.code = "upnvj";
        tenant.name = "UPN Veteran Jakarta";
        tenant.persist();

        Computer pc = new Computer();
        pc.tenantId = tenant.id;
        pc.label = "PC-TEST-01";
        pc.persist();

        computerId = pc.id;
    }

    @Test
    @DisplayName("Reservasi komputer pada slot kosong harus berhasil (201 Created)")
    public void testReservationSuccess() {
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "computerId", computerId,
                "memberRef", "2410512136",
                "slotStart", "2026-11-20T09:00:00Z"
            ))
        .when()
            .post("/computers/reservations")
        .then()
            .statusCode(201)
            .body("reservationId", notNullValue())
            .body("label", equalTo("PC-TEST-01"))
            .body("memberRef", equalTo("2410512136"));
    }

    @Test
    @DisplayName("Pencegahan double-booking: Reservasi pada slot dan komputer yang sama harus ditolak (409 Conflict - QS02)")
    public void testDoubleBookingConflict() {
        // Reservasi pertama oleh Mahasiswa 1
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "computerId", computerId,
                "memberRef", "2410512136",
                "slotStart", "2026-11-20T10:00:00Z"
            ))
        .when()
            .post("/computers/reservations")
        .then()
            .statusCode(201);

        // Reservasi kedua oleh Mahasiswa 2 pada slot dan komputer yang sama persis
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "computerId", computerId,
                "memberRef", "2410512088",
                "slotStart", "2026-11-20T10:00:00Z"
            ))
        .when()
            .post("/computers/reservations")
        .then()
            .statusCode(409)
            .body("error", containsString("double booking"));
    }
}
