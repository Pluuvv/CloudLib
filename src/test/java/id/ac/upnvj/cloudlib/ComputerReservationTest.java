package id.ac.upnvj.cloudlib;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
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
                "memberRef", "member-001",
                "slotStart", "2026-11-20T09:00:00Z"
            ))
        .when()
            .post("/computers/reservations")
        .then()
            .statusCode(201)
            .body("reservationId", notNullValue())
            .body("label", equalTo("PC-TEST-01"))
            .body("memberRef", equalTo("member-001"));
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
                "memberRef", "member-001",
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
                "memberRef", "member-002",
                "slotStart", "2026-11-20T10:00:00Z"
            ))
        .when()
            .post("/computers/reservations")
        .then()
            .statusCode(409)
            .body("error", containsString("double booking"));
    }

    @Test
    @DisplayName("Reservasi paralel pada komputer dan slot yang sama hanya boleh berhasil sekali")
    public void testConcurrentDoubleBookingConflict() throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);

        try {
            Callable<Integer> reserve = () -> {
                start.await();
                return given()
                    .header("X-Tenant", "upnvj")
                    .contentType(ContentType.JSON)
                    .body(Map.of(
                        "computerId", computerId,
                        "memberRef", "member-001",
                        "slotStart", "2026-11-20T11:00:00Z"
                    ))
                .when()
                    .post("/computers/reservations")
                .then()
                    .extract()
                    .statusCode();
            };

            Future<Integer> first = executor.submit(reserve);
            Future<Integer> second = executor.submit(reserve);
            start.countDown();

            assertThat(List.of(
                    first.get(10, TimeUnit.SECONDS),
                    second.get(10, TimeUnit.SECONDS)),
                    containsInAnyOrder(201, 409));
        } finally {
            executor.shutdownNow();
        }
    }
}
