<?php

use Enums\Whatsapp_Template_Parameter_Format;
use Whatsapp\Template\Components\Parameter;

class Merge_Vars
{

    private $cache;
    private string $medium;
    /** @var Parameter[]  */
    private array $whatsapp_component_parameters;
    private array $whatsapp_component_parameter_names;

    public const PLACE_DIRECTIONS_SQL = "CONCAT('https://maps.google.com/maps?q=', p.latitude, ',', p.longitude)";
    public const PLACE_MAP_SQL = "CONCAT(
        '<div style=\"max-width:600px; width:100%; margin:0 auto;\">',
            '<a href=\"', 
                CONCAT('https://maps.google.com/maps?q=', p.latitude, ',', p.longitude), 
            '\" style=\"display:block; text-decoration:none;\">',
                '<img src=\"', 
                    CONCAT(
                        'https://maps.googleapis.com/maps/api/staticmap?',
                        'center=', p.latitude, ',', p.longitude,
                        '&zoom=15',
                        '&size=600x300',
                        '&maptype=roadmap',
                        '&markers=color:red%7C', p.latitude, ',', p.longitude,
                        '&key=".GOOGLE_MAPS_API_KEY."'
                    ),
                '\" style=\"width:100%; max-width:600px; height:auto; display:block; border:0;\">',
            '</a>',
        '</div>'
    )";

    public function __construct( string $medium = 'email', array $params = null )   {

        $this->medium = $medium;

        if( isset( $params[ 'whatsapp_component_parameters' ] ) ) {

            $this->whatsapp_component_parameters = $params[ 'whatsapp_component_parameters' ];

        }

        if( isset( $params[ 'whatsapp_component_parameter_names' ] ) ) {

            $this->whatsapp_component_parameter_names = $params[ 'whatsapp_component_parameter_names' ];

        }

    }

    public static function merge_vars( string $template = '', string $medium = 'email', array $params = null ): ?array
    {

        $merge_vars = array( 'INBOUND', 'COURSE_PRICE', 'REGISTRATION_VALUE', 'AFFILIATE_ID', 'REGISTRATION_ID', 'REGISTRATION_STATUS', 'VARIABLE_SYMBOL', 'COMPANY',
            'COURSE_PLACE', 'COURSE_PID', 'COURSE_PLACE_ID', 'COURSE_ROOM_ID', 'COURSE_NAME', 'SCHEDULE_NAME', 'COURSE_DATE', 'COURSE_DATE_DAY', 'COURSE_SUMMARY', 'COURSE_TIME', 'SCHEDULE_DURATION',
            'FIRST_NAME', 'LAST_NAME', 'FULL_NAME', 'ALLOW_REPLACEMENTS', 'IBAN', 'DEFAULT_COURSE_PRICE', 'DEBT', 'CURRENT_BALANCE', 'CURRENT_BALANCE_ABS', 'PAID', 'QR_CODE',
            'COURSE_DATE_START_END', 'COURSE_TRAINER', 'USER_ID', 'WIDGET_VIDEO_URL', 'PROFILE_TOKEN', 'WIDGET_PROFILE_URL', 'WIDGET_REGISTRATION_URL', 'CUSTOM_CUSTOMER_ID',
            'EF_DOB', 'EF_FULL_NAME', 'EF_ADDRESS', 'EF_BUSINESS_NAME', 'EF_BUSINESS_ADDRESS', 'EF_BUSINESS_ID', 'EF_TAX_ID', 'EF_VAT', 'IS_BUSINESS_ORDER',
            'EF_IDENTIFICATION_NUMBER', 'HAS_DOWNPAYMENT', 'HAS_UNPAID_DOWNPAYMENT', 'DOWNPAYMENT', 'DOWNPAYMENT_DUE_DATE', 'QR_CODE_DOWNPAYMENT',
            'CANCELLATION_SCHEDULED', 'CANCELLATION_DATE',
            'EF_EXTRA_FIELD_1', 'EF_EXTRA_FIELD_2', 'EF_EXTRA_FIELD_3', 'EF_EXTRA_FIELD_4', 'EF_EXTRA_FIELD_5',
            'EF_EXTRA_FIELD_6', 'EF_EXTRA_FIELD_7', 'EF_EXTRA_FIELD_8', 'EF_EXTRA_FIELD_9', 'EF_EXTRA_FIELD_10',
            'EF_EXTRA_FIELD_11', 'EF_EXTRA_FIELD_12', 'EF_EXTRA_FIELD_13', 'EF_EXTRA_FIELD_14', 'EF_EXTRA_FIELD_15',
            'EF_CITIZENSHIP', 'COURSE_PAYMENT', 'REGISTRATION_FEE', 'PAYMENT_STATUS',
            'ORDER_SUMMARY', 'PAYMENT_STATUS_CODE', 'ONLINE_MEETING_LINK', 'ONLINE_MEETING_URL', 'HAS_ONLINE_MEETING', 'EVENT_HAS_ONLINE_MEETING',
            'EVENT_ONLINE_MEETING_LINK', 'EVENT_ONLINE_MEETING_URL',
            'EVENT_COURSE',  'EVENT_TRAINER', 'EVENT_PLACE', 'EVENT_PLACE_DIRECTIONS', 'EVENT_PLACE_MAP', 'EVENT_NAME', 'EVENT_TRAINER', 'EVENT_DATE', 'EVENT_DATE_DAY', 'EVENT_TIME', 'EVENT_ATTENDANCE_NOTE',
            'EVENT_PUBLIC_SUMMARY', 'SCHEDULE_TYPE', 'PLACE_DIRECTIONS', 'PLACE_MAP',
            'USER_CREATED', 'NOW', 'CURDATE', 'ORDER_ID',
        );

        if( $template !== '' && defined( 'System_Notification::TYPE_' . strtoupper( $template ) ) ) {

            $value = constant('System_Notification::TYPE_' . strtoupper( $template ) );
            $n = new System_Notification( $value );
            $merge_vars = array_unique( array_merge( $merge_vars, $n->merge_vars ) );

        }

        if( $medium === 'whatsapp' && !empty( $params[ 'whatsapp_component_parameter_names' ] ) ) {

            // only add merge var if it is in the template
            $whatsapp_component_parameter_names = $params[ 'whatsapp_component_parameter_names' ];
            $merge_vars = array_intersect( $merge_vars, $whatsapp_component_parameter_names );
            // ADD registration_id AS this is needed to assign merge vars to a registration
            $merge_vars[] = 'REGISTRATION_ID';
            $merge_vars[] = 'USER_ID';

        }

        return $merge_vars;

    }

    public function manual_merge( Registration $registration, string $string ):string  {

        $merge_vars = self::merge_vars();
        $registration_ids = array( $registration->id );
        $r = new \Simple_Registration( $registration->id );
        $recipients = array( $registration->id => array(
            'to' => array(
                'email' => $registration->get( '__users__email' ),
                'name'  => $registration->get( '__users__full_name' ),
                'to'    => 'to',
            ),
            'data' => $r->registration,
        )
        );
        $fake_course_id = $registration->get( 'course_id' );
        $fake_company_id = $registration->get( 'company_id' );
        $ignore_company = true;

        if( isset( $this->cache ) ) {

            $recipients = $this->cache;

        } else {

            $this->get_merge_vars_data( $merge_vars, $registration_ids, $recipients, $ignore_company, $fake_company_id, $fake_course_id );
            $this->cache = $recipients;

        }

        return $this->replace_merge_vars( $string, $recipients[ $registration->id ][ 'merge_vars' ][ 'vars' ] );

    }

    private function replace_merge_vars ( $string, $merge_vars ):string {

        foreach( $merge_vars as $var ) {

            $tag = '*|' . $var[ 'name' ] . '|*';
            $string = str_replace( $tag, $var[ 'content' ], $string );

        }

        return $string;

    }

    public function get_merge_vars_data( $merge_vars, $registration_ids, &$registrations, $ignore_company = false, $fake_company_id = 0, $fake_course_id = 0 ): void
    {
        global $api;

        #var_dump('merge_vars_start');
//        var_dump($registrations);

        $select = array();
        $join   = array( ' ' );

        $merge_vars = array_flip( $merge_vars );

        $select[] = "r.currency AS CURRENCY";

        if( isset( $merge_vars[ 'COURSE_PRICE' ] ) )    {

//        $select[] = "CONCAT( FORMAT( ABS( r.__calc__balance ), 2 ), ' €' ) AS COURSE_PRICE";
            $select[] = "ABS( r.__calc__balance ) AS COURSE_PRICE";

        }

        if( isset( $merge_vars[ 'INBOUND' ] ) )    {

            $select[] = "CONCAT( 'INBS-RID:', r.id, '-INBE' ) AS INBOUND";

        }

        if( isset( $merge_vars[ 'ORDER_SUMMARY' ] ) )    {

            $select[] = "r.__calc__order_summary AS ORDER_SUMMARY";

        }

        if( isset( $merge_vars[ 'DOWNPAYMENT' ] ) )    {

            $select[] = "r.downpayment AS DOWNPAYMENT";

        }

        if( isset( $merge_vars[ 'HAS_DOWNPAYMENT' ] ) )    {

            $select[] = "IF( r.downpayment > 0, 1, 0 ) AS HAS_DOWNPAYMENT";

        }

        if( isset( $merge_vars[ 'HAS_UNPAID_DOWNPAYMENT' ] ) )    {

            $select[] = "r.payment_status AS HAS_UNPAID_DOWNPAYMENT";

        }

        if( isset( $merge_vars[ 'CANCELLATION_SCHEDULED' ] ) )    {

            $select[] = "IF( r.status_change_scheduled_at IS NOT NULL
                             AND r.status_change_scheduled_at != '0000-00-00'
                             AND r.scheduled_status = 'canceled', 1, 0 ) AS CANCELLATION_SCHEDULED";

        }

        if( isset( $merge_vars[ 'CANCELLATION_DATE' ] ) )    {

            $select[] = "COALESCE(
                             IF( r.status_change_scheduled_at IS NOT NULL
                                 AND r.status_change_scheduled_at != '0000-00-00'
                                 AND r.scheduled_status = 'canceled',
                                 DATE_FORMAT( r.status_change_scheduled_at, '%Y-%m-%d' ),
                                 ''
                             ), '' ) AS CANCELLATION_DATE";

        }

        if( isset( $merge_vars[ 'USER_CREATED' ] ) )    {

            $join[ 'users_companies' ] = "users_companies uc ON uc.user_id = r.user_id AND uc.company_id = r.company_id";
            $select[] = "uc.created AS USER_CREATED";

        }

        if( isset( $merge_vars[ 'CURDATE' ] ) )    {

            $select[] = "null AS CURDATE";

        }

        if( isset( $merge_vars[ 'NOW' ] ) )    {

            $select[] = "null AS NOW";

        }

        if( isset( $merge_vars[ 'DOWNPAYMENT_DUE_DATE' ] ) )    {

            $select[] = "r.downpayment_due AS DOWNPAYMENT_DUE_DATE";

        }

        if( isset( $merge_vars[ 'REGISTRATION_VALUE' ] ) )    {

//        $select[] = "CONCAT( FORMAT( ABS( r.`value` ), 2 ), ' €' ) AS REGISTRATION_VALUE";
            $select[] = "ABS( r.`value` ) AS REGISTRATION_VALUE";

        }

        if( isset( $merge_vars[ 'REGISTRATION_ID' ] ) )    {
            $select[] = "r.id AS REGISTRATION_ID";
        }

        if( isset( $merge_vars[ 'IBAN' ] ) || isset( $merge_vars[ 'QR_CODE' ] ) )    {
            $select[] = "CASE WHEN (r.iban IS NOT NULL AND r.iban != '') THEN r.iban WHEN c.iban IS NOT NULL THEN c.iban ELSE co.iban END AS IBAN";
            $select[] = "CASE WHEN (r.iban IS NOT NULL AND r.iban != '') THEN r.iban WHEN c.iban IS NOT NULL THEN c.iban ELSE co.iban END AS IBAN_ONLY";
            $select[] = "CASE WHEN (r.iban_account_holder IS NOT NULL AND r.iban_account_holder != '') THEN r.iban_account_holder WHEN (c.iban_account_holder IS NOT NULL AND c.iban_account_holder != '') THEN c.iban_account_holder ELSE co.iban_account_holder END AS IBAN_ACCOUNT_HOLDER";
            $join[ 'companies' ] = 'companies co ON co.id = r.company_id';
            $join[ 'courses' ] = 'courses c ON c.id = r.course_id';
        }

        if( isset( $merge_vars[ 'DEFAULT_COURSE_PRICE' ] ) )    {
            $select[] = "ABS( IF( r.__calc__debt < 0, r.__calc__debt, IF( c.price = 0 && s.price != 0, s.price, c.price ) ) ) AS DEFAULT_COURSE_PRICE";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }


        if( isset( $merge_vars[ 'SCHEDULE_TYPE' ] ) )    {

            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
            $select[] = "s.schedule_type AS SCHEDULE_TYPE";

        }

        if( isset( $merge_vars[ 'ONLINE_MEETING_LINK' ] ) )    {

            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
            $select[ 'online_meeting_provider' ] = "s.online_meeting_provider AS ONLINE_MEETING_PROVIDER";
            $select[ 'online_meeting_id' ] = "s.online_meeting_id AS ONLINE_MEETING_ID";
            $select[] = "'' AS ONLINE_MEETING_LINK";

        }

        if( isset( $merge_vars[ 'ONLINE_MEETING_URL' ] ) )    {

            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
            $select[ 'online_meeting_provider' ] = "s.online_meeting_provider AS ONLINE_MEETING_PROVIDER";
            $select[ 'online_meeting_id' ] = "s.online_meeting_id AS ONLINE_MEETING_ID";
            $select[] = "'' AS ONLINE_MEETING_URL";

        }
        if( isset( $merge_vars[ 'EVENT_ONLINE_MEETING_LINK' ] ) )    {

            $select[] = "'' AS EVENT_ONLINE_MEETING_LINK";

        }

        if( isset( $merge_vars[ 'EVENT_ONLINE_MEETING_URL' ] ) )    {

            $select[] = "'' AS EVENT_ONLINE_MEETING_URL";

        }


        if( isset( $merge_vars[ 'HAS_ONLINE_MEETING' ] ) )    {

            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
            // Keep supported-provider list in sync with Utils::get_online_meeting_url() in class/Utils.php
            $select[] = "IF( s.online_meeting_id IS NOT NULL AND s.online_meeting_id <> '' "
                      . "AND s.online_meeting_provider IS NOT NULL "
                      . "AND LOWER(s.online_meeting_provider) IN ('zoom','google_meet'), 1, 0 ) AS HAS_ONLINE_MEETING";

        }

        if( isset( $merge_vars[ 'EVENT_HAS_ONLINE_MEETING' ] ) )    {

            $select[] = "0 AS EVENT_HAS_ONLINE_MEETING";

        }

        if( isset( $merge_vars[ 'PLACE_DIRECTIONS' ] ) ) {

            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
            $join[ 'places' ] = "places p ON p.id = s.place_id";
            $select[] = self::PLACE_DIRECTIONS_SQL . " AS PLACE_DIRECTIONS";

        }

        if( isset( $merge_vars[ 'PLACE_MAP' ] ) ) {

            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
            $join[ 'places' ] = "places p ON p.id = s.place_id";
            $select[] = self::PLACE_MAP_SQL . " AS PLACE_MAP";

        }

        if( isset( $merge_vars[ 'DEBT' ] ) )    {
            $select[] = "ABS( IF( r.__calc__debt < 0, r.__calc__debt,
    IF( c.price = 0 && s.price != 0, s.price, c.price ) ) ) AS DEBT";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'CURRENT_BALANCE' ] ) )    {
            $select[] = "r.__calc__balance AS CURRENT_BALANCE";
        }

        if( isset( $merge_vars[ 'CURRENT_BALANCE_ABS' ] ) )    {
            $select[] = "r.__calc__balance AS CURRENT_BALANCE_ABS";
        }

        if( isset( $merge_vars[ 'PAID' ] ) )    {
            $select[] = "r.__calc__paid AS PAID";
        }

        if( isset( $merge_vars[ 'COURSE_PAYMENT' ] ) )    {
            $select[] = "ABS( IF( r.__calc__course_payment < 0, r.__calc__course_payment,
    IF( c.price = 0 && s.price != 0, s.price, c.price ) ) ) AS COURSE_PAYMENT";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'REGISTRATION_FEE' ] ) )    {
            $select[] = "ABS( IF( r.__calc__registration_fee < 0, r.__calc__registration_fee,
    IF( c.registration_fee = 0 && s.registration_fee != 0, s.registration_fee, c.registration_fee ) ) ) AS REGISTRATION_FEE";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'QR_CODE' ] ) )    {
            $select[] = "c.constant_symbol AS CONSTANT_SYMBOL";
            $select[] = "c.specific_symbol AS SPECIFIC_SYMBOL";
            $select[] = "co.region AS COMPANY_REGION";
            $select[] = "co.default_name AS COMPANY_NAME";
            $select[] = "CASE WHEN (r.iban IS NOT NULL) THEN r.swift WHEN c.iban IS NOT NULL THEN c.swift ELSE co.swift END AS SWIFT"; // kontroluj iban a pouzi swift aby sa nahodou nestalo ze nemam zadany iban ale swift ano
            $select[] = "ABS( IF( r.__calc__balance < 0, r.__calc__balance, 0 ) ) AS QR_CODE";
            $select[] = "IF( s.name != '', CONCAT( c.name, ' - ', s.name ), c.name ) AS QR_DESCRIPTION";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'QR_CODE_DOWNPAYMENT' ] ) )    {
            $select[] = "c.constant_symbol AS CONSTANT_SYMBOL";
            $select[] = "c.specific_symbol AS SPECIFIC_SYMBOL";
            $select[] = "co.region AS COMPANY_REGION";
            $select[] = "co.default_name AS COMPANY_NAME";
            $select[] = "CASE WHEN (r.iban IS NOT NULL) THEN r.swift WHEN c.iban IS NOT NULL THEN c.swift ELSE co.swift END AS SWIFT";
            $select[] = "r.downpayment AS QR_CODE_DOWNPAYMENT";
            $select[] = "IF( s.name != '', CONCAT( c.name, ' - ', s.name ), c.name ) AS QR_DESCRIPTION";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'AFFILIATE_ID' ] ) )    {
            $select[] = "r.affiliate_id AS AFFILIATE_ID";
        }

        if( isset( $merge_vars[ 'USER_ID' ] ) )    {
            $select[] = "r.user_id AS USER_ID";
        }

        if( isset( $merge_vars[ 'COURSE_ID' ] ) )    {
            $select[] = "r.course_id AS COURSE_ID";
        }

        if( isset( $merge_vars[ 'SCHEDULE_ID' ] ) )    {
            $select[] = "r.schedule_id AS SCHEDULE_ID";
        }

        if( isset( $merge_vars[ 'FIRST_NAME' ] ) )    {
            $select[] = "r.__users__first_name AS FIRST_NAME";
        }

        if( isset( $merge_vars[ 'FULL_NAME' ] ) )    {
            $select[] = "r.__users__full_name AS FULL_NAME";
        }

        if( isset( $merge_vars[ 'LAST_NAME' ] ) )    {
            $select[] = "r.__users__last_name AS LAST_NAME";
        }

        if( isset( $merge_vars[ 'EF_FULL_NAME' ] ) )    {
            $select[] = "r.__extra_fields__full_name AS EF_FULL_NAME";
        }

        if( isset( $merge_vars[ 'EF_IDENTIFICATION_NUMBER' ] ) )    {
            $select[] = "r.__extra_fields__identification_number AS EF_IDENTIFICATION_NUMBER";
        }

        if( isset( $merge_vars[ 'EF_DOB' ] ) )    {
            $select[] = "r.__extra_fields__dob AS EF_DOB";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_1' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_1 AS EF_EXTRA_FIELD_1";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_2' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_2 AS EF_EXTRA_FIELD_2";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_3' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_3 AS EF_EXTRA_FIELD_3";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_4' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_4 AS EF_EXTRA_FIELD_4";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_5' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_5 AS EF_EXTRA_FIELD_5";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_6' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_6 AS EF_EXTRA_FIELD_6";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_7' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_7 AS EF_EXTRA_FIELD_7";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_8' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_8 AS EF_EXTRA_FIELD_8";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_9' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_9 AS EF_EXTRA_FIELD_9";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_10' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_10 AS EF_EXTRA_FIELD_10";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_11' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_11 AS EF_EXTRA_FIELD_11";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_12' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_12 AS EF_EXTRA_FIELD_12";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_13' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_13 AS EF_EXTRA_FIELD_13";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_14' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_14 AS EF_EXTRA_FIELD_14";
        }

        if( isset( $merge_vars[ 'EF_EXTRA_FIELD_15' ] ) )    {
            $select[] = "r.__extra_fields__extra_field_15 AS EF_EXTRA_FIELD_15";
        }

        if( isset( $merge_vars[ 'EF_CITIZENSHIP' ] ) )    {
            $select[] = "r.__extra_fields__citizenship AS EF_CITIZENSHIP";
        }

        if( isset( $merge_vars[ 'EF_ADDRESS' ] ) )    {
            $select[] = "r.__extra_fields__address AS EF_ADDRESS";
        }

        if( isset( $merge_vars[ 'EF_BUSINESS_NAME' ] ) )    {
            $select[] = "r.__extra_fields__business_name AS EF_BUSINESS_NAME";
        }

        if( isset( $merge_vars[ 'EF_BUSINESS_ADDRESS' ] ) )    {
            $select[] = "r.__extra_fields__business_address AS EF_BUSINESS_ADDRESS";
        }

        if( isset( $merge_vars[ 'EF_BUSINESS_ID' ] ) )    {
            $select[] = "r.__extra_fields__business_id AS EF_BUSINESS_ID";
        }

        if( isset( $merge_vars[ 'EF_TAX_ID' ] ) )    {
            $select[] = "r.__extra_fields__tax_id AS EF_TAX_ID";
        }

        if( isset( $merge_vars[ 'EF_VAT' ] ) )    {
            $select[] = "r.__extra_fields__vat AS EF_VAT";
        }

        if( isset( $merge_vars[ 'IS_BUSINESS_ORDER' ] ) )    {
            $select[] = "r.business_order AS IS_BUSINESS_ORDER";
        }

        if( isset( $merge_vars[ 'REGISTRATION_STATUS' ] ) )    {
            $select[] = "r.status AS REGISTRATION_STATUS";
        }

        if( isset( $merge_vars[ 'VARIABLE_SYMBOL' ] ) || isset( $merge_vars[ 'QR_CODE' ] ) )    {
            $select[] = "r.id AS VARIABLE_SYMBOL";
        }

        if( isset( $merge_vars[ 'ORDER_ID' ] ) )    {
            $select[] = "r.id AS ORDER_ID";
        }

        if( isset( $merge_vars[ 'VOTING' ] ) )    {
            $select[] = "'https://feedback.zooza.app/#' AS VOTING";
        }

        if( isset( $merge_vars[ 'UNSUBSCRIBE' ] ) )    {
            $select[] = "'https://unsubscribe.zooza.sk/' AS UNSUBSCRIBE";
        }

        if( isset( $merge_vars[ 'FEEDBACK_REQUEST_ID' ] ) )    {
            $select[] = "'' AS FEEDBACK_REQUEST_ID";
        }

        if( isset( $merge_vars[ 'COMPANY' ] ) )    {
            $select[] = "co.name AS COMPANY";
            $join[ 'companies' ] = "companies co ON co.id = r.company_id";

        }

        if( isset( $merge_vars[ 'COMPANY_EMAIL' ] ) )    {
            $select[] = "co.email AS COMPANY_EMAIL";
            $join[ 'companies' ] = "companies co ON co.id = r.company_id";
        }

        if( isset( $merge_vars[ 'COMPANY_LOGO' ] ) )    {
            $select[] = "co.logo AS COMPANY_LOGO";
            $join[ 'companies' ] = "companies co ON co.id = r.company_id";
        }

        if( isset( $merge_vars[ 'COMPANY_URL' ] ) )    {
            $select[] = "co.url AS COMPANY_URL";
            $join[ 'companies' ] = "companies co ON co.id = r.company_id";
        }

        if( isset( $merge_vars[ 'COURSE_PID' ] ) )    {

            $select[] = "CONCAT( s.place_id, '_', s.room_id ) AS COURSE_PID";

        }

        if( isset( $merge_vars[ 'COURSE_PLACE_ID' ] ) )    {

            $select[] = "s.place_id AS COURSE_PLACE_ID";

        }

        if( isset( $merge_vars[ 'COURSE_ROOM_ID' ] ) )    {

            $select[] = "s.room_id AS COURSE_ROOM_ID";

        }

        if( isset( $merge_vars[ 'COURSE_PLACE' ] ) )    {

            $select[] = "r.__calc__course_place AS COURSE_PLACE";

        }

        if( isset( $merge_vars[ 'COURSE_NAME' ] ) )    {
            $select[] = "IF( s.name != '',
                        CONCAT( c.name, ' - ', s.name ),
                         c.name ) AS COURSE_NAME";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'ALLOW_REPLACEMENTS' ] ) )    {
            $select[] = "c.allow_replacements AS ALLOW_REPLACEMENTS";
            $join[ 'courses' ] = "courses c ON c.id = r.course_id";
        }

        if( isset( $merge_vars[ 'COURSE_DATE_DAY' ] ) )    {
            $select[] = "DATE_FORMAT(IF(r.__events__first_event != '', r.__events__first_event, s.start), '%w' ) AS COURSE_DATE_DAY";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'PAYMENT_STATUS_CODE' ] ) )    {
            $select[] = "r.payment_status AS PAYMENT_STATUS_CODE";
        }

        if( isset( $merge_vars[ 'PAYMENT_STATUS' ] ) )    {
            $select[] = "r.payment_status AS PAYMENT_STATUS";
        }

        if( isset( $merge_vars[ 'COURSE_SUMMARY' ] ) )    {
            $select[] = "IF(r.__events__first_event != '', r.__events__first_event, s.start) AS COURSE_SUMMARY";
            $select[] = "s.time AS __COURSE_SUMMARY_TIME";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'COURSE_TIME' ] ) )    {
            $select[] = "s.time AS COURSE_TIME";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'COURSE_DATE' ] ) )    {
            $select[] = "IF(r.__events__first_event != '', r.__events__first_event, s.start) AS COURSE_DATE";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        // duplicate of course_time, but this shouldn't be from schedule but from the event
        if( isset( $merge_vars[ 'EVENT_TIME' ] ) )    {
            $select[] = "s.time AS EVENT_TIME";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'EVENT_DATE' ] ) )    {
            $select[] = "'' AS EVENT_DATE";
        }

        if( isset( $merge_vars[ 'EVENT_TRAINER' ] ) )    {
            $select[] = "'' AS EVENT_TRAINER";
        }

        if( isset( $merge_vars[ 'EVENT_DATE_DAY' ] ) )    {
            $select[] = "'' AS EVENT_DATE_DAY";
        }

        // duplicate of event_time, no this should be from event
        if( isset( $merge_vars[ 'EVENT_DATE' ] ) )    {
            $select[] = "'' AS EVENT_DATE";
        }

        if( isset( $merge_vars[ 'EVENT_PUBLIC_SUMMARY' ] ) )    {
            $select[] = "'' AS EVENT_PUBLIC_SUMMARY";
        }

        if( isset( $merge_vars[ 'EVENT_ATTENDANCE_NOTE' ] ) )    {
            $select[] = "'' AS EVENT_ATTENDANCE_NOTE";
        }

        if( isset( $merge_vars[ 'UPCOMING_EVENTS' ] ) )    {
            $select[] = "'' AS UPCOMING_EVENTS";
        }

        if( isset( $merge_vars[ 'TURN_OFF_UPCOMING_EVENTS_NOTIFICATIONS_URL' ] ) )    {
            $select[] = "wreg.url AS TURN_OFF_UPCOMING_EVENTS_NOTIFICATIONS_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";
            $join[ 'widgets_registration' ] = "widgets_2 wreg ON wreg.application_id = a.id AND wreg.type = 'registration'";
        }

        if( isset( $merge_vars[ 'EVENT_NAME' ] ) )    {
            $select[] = "'' AS EVENT_NAME";
        }

        if( isset( $merge_vars[ 'EVENT_COURSE' ] ) )    {
            $select[] = "'' AS EVENT_COURSE";
        }

        if( isset( $merge_vars[ 'SCHEDULE_NAME' ] ) )    {
            $select[] = "s.name AS SCHEDULE_NAME";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'EVENT_PLACE' ] ) )    {
            $select[] = "'' AS EVENT_PLACE";
        }

        if( isset( $merge_vars[ 'EVENT_PLACE_DIRECTIONS' ] ) )    {
            $select[] = "'' AS EVENT_PLACE_DIRECTIONS";
        }

        if( isset( $merge_vars[ 'EVENT_PLACE_MAP' ] ) )    {
            $select[] = "'' AS EVENT_PLACE_MAP";
        }

        if( isset( $merge_vars[ 'EVENT_TRAINER' ] ) )    {
            $select[] = "'' AS EVENT_TRAINER";
        }

        if( isset( $merge_vars[ 'SCHEDULE_DURATION' ] ) )    {
            $select[] = "s.duration AS SCHEDULE_DURATION";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'COURSE_DATE_START_END' ] ) )    {
            $select[] = "IF(r.__events__first_event != '', r.__events__first_event, s.start) AS COURSE_DATE_START_END";
            $select[] = "s.end AS __COURSE_END_DATE";
            $join[ 'schedules' ] = "schedules s ON s.id = r.schedule_id";
        }

        if( isset( $merge_vars[ 'DATE' ] ) )    {
            $select[] = "NOW() AS DATE";
        }

        if( isset( $merge_vars[ 'COURSE_TRAINER' ] ) )    {
            $select[] = "IF( s.trainer_id > 9000000000000, s.trainer_id, IF( uf.show_only_nick, 
                            uf.nick, 
                            IF( uf.nick != '', 
                                CONCAT( uf.nick, ' (', t.first_name, ' ', t.last_name, ')' ), 
                                CONCAT( t.first_name, ' ', t.last_name ) 
                            ) 
                        ) ) AS COURSE_TRAINER";

            $join[ 'trainers' ] = "users t ON t.id = s.trainer_id";
            $join[ 'user_fields' ] = "user_fields uf ON uf.user_id = s.trainer_id AND uf.company_id = r.company_id";
        }

        if( isset( $merge_vars[ 'CUSTOM_CUSTOMER_ID' ] ) )    {
            $select[] = "ufu.custom_customer_id AS CUSTOM_CUSTOMER_ID";
            $join[ 'user_fields_user' ] = "user_fields ufu ON ufu.user_id = r.user_id AND ufu.company_id = r.company_id";
        }

        if( isset( $merge_vars[ 'WIDGET_VIDEO_URL' ] ) )    {

            $select[] = "wv.url AS WIDGET_VIDEO_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";
            $join[ 'widgets_video' ] = "widgets_2 wv ON wv.application_id = a.id AND wv.type = 'video'";

        }

        if( isset( $merge_vars[ 'WIDGET_REGISTRATION_URL' ] ) )    {

            $select[] = "wreg.url AS WIDGET_REGISTRATION_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";
            $join[ 'widgets_registration' ] = "widgets_2 wreg ON wreg.application_id = a.id AND wreg.type = 'registration'";

        }

        if( isset( $merge_vars[ 'PROFILE_TOKEN' ] ) )    {

            $select[] = "'' AS PROFILE_TOKEN";

        }

        if( isset( $merge_vars[ 'BOOKING_TOKEN' ] ) )    {

            $select[] = "'' AS BOOKING_TOKEN";

        }

        if( isset( $merge_vars[ 'WIDGET_PROFILE_URL' ] ) )    {

            $select[] = "wp.url AS WIDGET_PROFILE_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";

            $join[ 'widgets_profile' ] = "widgets_2 wp ON wp.application_id = a.id AND wp.type = 'profile'";

        }

        if( isset( $merge_vars[ 'BOOKING_URL' ] ) )    {

            $select[] = "wreg.url AS BOOKING_URL";
            $select[] = "IF( r.after_trial_schedule_id IS NOT NULL, r.after_trial_schedule_id, r.schedule_id ) AS __SCHEDULE_ID";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";

            $join[ 'widgets_registration' ] = "widgets_2 wreg ON wreg.application_id = a.id AND wreg.type = 'registration'";

        }

        if( isset( $merge_vars[ 'GOING_CONFIRMATION_URL' ] ) )    {

            $select[] = "wreg.url AS GOING_CONFIRMATION_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";

            $join[ 'widgets_registration' ] = "widgets_2 wreg ON wreg.application_id = a.id AND wreg.type = 'registration'";

        }

        if( isset( $merge_vars[ 'CANCEL_TOKEN' ] ) )    {

            $select[] = "'' AS CANCEL_TOKEN";

        }

        if( isset( $merge_vars[ 'CANCELED_CONFIRMATION_URL' ] ) )    {

            $select[] = "wreg.url AS CANCELED_CONFIRMATION_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) )
                AND a.active = 1 AND a.type = 'widget'";

            $join[ 'widgets_registration' ] = "widgets_2 wreg ON wreg.application_id = a.id AND wreg.type = 'registration'";

        }

        if( isset( $merge_vars[ 'TURN_OFF_EVENT_NOTIFICATIONS_URL' ] ) )    {

            $select[] = "wreg.url AS TURN_OFF_EVENT_NOTIFICATIONS_URL";
//        $join[ 'applications' ] = "applications a ON r.company_id = a.company_id AND a.active = 1 AND a.type = 'widget'";
            $join[ 'applications' ] = "applications a ON ( 
                ( r.application_id > 0 AND a.id = r.application_id ) 
                OR ( r.application_id = 0 AND r.company_id = a.company_id ) ) 
                AND a.active = 1 AND a.type = 'widget'";

            $join[ 'widgets_registration' ] = "widgets_2 wreg ON wreg.application_id = a.id AND wreg.type = 'registration'";

        }

        if( $fake_company_id > 0 )  {
// dont alter application join as when user wants to cancel event he has to do so on it's own profile
            $join[ 'companies' ] = 'companies co ON co.id = ' . $fake_company_id;

        }

        if( $fake_course_id > 0 )   {

            $join[ 'courses' ] = 'courses c ON c.id = ' . $fake_course_id;

        }

        if( $ignore_company )   {

            $args = array();
            $company = '';

        } else  {

            $args = array(
                ':company_id' => $api->request[ 'company_id' ],
            );
            $company = ' AND r.company_id = :company_id ';

        }

        $sql = sprintf( "SELECT 
                    %s
                FROM registrations r
                    %s
                WHERE r.id IN( %s )
                %s
                GROUP BY r.id",
            implode( ', ', $select ),
            implode( ' LEFT JOIN ', $join ),
            implode( ', ', $registration_ids ),
            $company
        );

        $rows = $api->db->fetch_all( $sql, $args );


//var_dump($sql, $args, $rows, $registrations);
        foreach( $rows as $row )    {

            $api->request[ 'error_data' ][ 'merge_vars' ][ 'rows' ][] = $row->REGISTRATION_ID;

            $email = $registrations[ $row->REGISTRATION_ID ][ 'to' ][ 'email' ];
            $login_token = null;
            $action_token = null;
            $vars = array();

            $currency = $api->company->get_currency();
            if( isset( $row->CURRENCY) && $row->CURRENCY != '' )    {
                $currency = $row->CURRENCY;
            }

            foreach ($row as $key => $value )   {

                $api->request[ 'error_data' ][ 'merge_vars' ][ 'keys' ][] = array( 'key' => $key, 'value' => $value );
                // check if additional properties are present in the registration and if not, then add them to prevent fatal error
                // when additional data are provided they are in a form of an array
                // when regular mass email is sent the data is the registration object stdClass
                // so if the data object is array - do nothing but if it is an object - convert
                $registration_data = $registrations[ $row->REGISTRATION_ID ][ 'data'];

                if( $key == 'COURSE_DATE_DAY' ) {
                    $value = mysql_day_to_string( intval( $value ) );
                } else if( $key == 'COURSE_PRICE' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'COURSE_TRAINER' ) {
                    $value = localize_trainer( $value );
                } else if( $key == 'REGISTRATION_VALUE' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'DEFAULT_COURSE_PRICE' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'COURSE_PAYMENT' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'REGISTRATION_FEE' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'DOWNPAYMENT' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'CURRENT_BALANCE' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'CURRENT_BALANCE_ABS' ) {
                    $value = euro( abs( $value ), $currency );
                } else if( $key == 'PAID' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'DEBT' ) {
                    $value = euro( $value, $currency );
                } else if( $key == 'IBAN_ONLY' ) {
                    $value = iban( $value );
                } else if( $key == 'IBAN' ) {
                    $value = iban( $value );

                    foreach( $row as $key2 => $value2 ) {
                        if( $key2 == 'IBAN_ACCOUNT_HOLDER' && !empty( $value2 ) ) {
                            $value = $value . ' (' . $value2 . ')';
                            break;
                        }
                    }

                } else if( $key == 'PAYMENT_STATUS' ) {
                    $value = $api->__( 'payment_status_' . $value );
                } else if( $key == 'QR_CODE' ) {
                    $value = self::get_qr_code_html( $row );
                } else if( $key == 'QR_CODE_DOWNPAYMENT' ) {
                    if( floatval( $value ) > 0 ) {
                        $temp = clone $row;
                        $temp->QR_CODE = $value;
                        $value = self::get_qr_code_html( $temp );
                    } else {
                        $value = '';
                    }
                } else if( $key == 'ONLINE_MEETING_LINK' ) {

                    $provider = null;
                    $id = null;
                    foreach( $row as $key2 => $value2 ) {
                        if( $key2 == 'ONLINE_MEETING_PROVIDER' ) {
                            $provider = $value2;
                        } else if( $key2 == 'ONLINE_MEETING_ID' ) {
                            $id = $value2;
                        }
                        if( $provider != null && $id != null ) {
                            break;
                        }
                    }

                    $url = Utils::get_online_meeting_url( $provider, $id );
                    if( is_null( $url ) ) {
                        $value = '';
                    } else {
                        $value = '<a href="'.$url.'" target="_blank">'.$url.'</a>';
                    }

                } else if( $key == 'ONLINE_MEETING_URL' ) {

                    $provider = null;
                    $id = null;
                    foreach( $row as $key2 => $value2 ) {
                        if( $key2 == 'ONLINE_MEETING_PROVIDER' ) {
                            $provider = $value2;
                        } else if( $key2 == 'ONLINE_MEETING_ID' ) {
                            $id = $value2;
                        }
                        if( $provider != null && $id != null ) {
                            break;
                        }
                    }

                    $url = Utils::get_online_meeting_url( $provider, $id );
                    if( is_null( $url ) ) {
                        $value = '';
                    } else {
                        $value = $url;
                    }

                } else if( $key == 'EVENT_ONLINE_MEETING_LINK' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'online_meeting_id' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->online_meeting_id ) )
                    ) ) {

                    $provider = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'online_meeting_provider' ] : $registration_data->events->online_meeting_provider;
                    $id = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'online_meeting_id' ] : $registration_data->events->online_meeting_id;
                    $url = Utils::get_online_meeting_url( $provider, $id );

                    if( !is_null( $url ) ) {
                        $value = '<a href="'.$url.'" target="_blank">'.$url.'</a>';
                    } else {
                        $value = '';
                    }

                } else if( $key == 'EVENT_ONLINE_MEETING_URL' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'online_meeting_id' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->online_meeting_id ) )
                    ) ) {

                    $provider = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'online_meeting_provider' ] : $registration_data->events->online_meeting_provider;
                    $id = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'online_meeting_id' ] : $registration_data->events->online_meeting_id;
                    $url = Utils::get_online_meeting_url( $provider, $id );

                    if( !is_null( $url ) ) {
                        $value = $url;
                    } else {
                        $value = '';
                    }

                } else if( $key == 'EVENT_HAS_ONLINE_MEETING' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'has_online_meeting' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->has_online_meeting ) )
                    ) ) {

                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'has_online_meeting' ] : $registration_data->events->has_online_meeting;

                } else if( $key == 'EVENT_PLACE' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'place' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->place ) )
                    ) ) {
                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'place' ] : $registration_data->events->place;
                } else if( $key == 'EVENT_PLACE_DIRECTIONS' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'place_directions' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->place_directions ) )
                    ) ) {
                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'place_directions' ] : $registration_data->events->place_directions;
                } else if( $key == 'EVENT_PLACE_MAP' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'place_map' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->place_map ) )
                    ) ) {
                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'place_map' ] : $registration_data->events->place_map;
                } else if( $key == 'EVENT_TRAINER' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'trainer' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->trainer ) )
                    ) ) {
                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'trainer' ] : $registration_data->events->trainer;

                } else if( $key == 'EVENT_NAME' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'name' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->name ) )
                    ) ) {
                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'name' ] : $registration_data->events->name;

                } else if( $key == 'EVENT_COURSE' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'course' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->course ) )
                    ) ) {
                    $value = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'course' ] : $registration_data->events->course;

                } else if( $key == 'EVENT_DATE' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'date' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->date ) )
                    ) ) {
                    $date = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'date' ] : $registration_data->events->date;
                    $date = DateTime::createFromFormat( 'Y-m-d H:i:s', $date );
                    $value = format_date( $date, IntlDateFormatter::NONE );
                } else if( $key == 'HAS_UNPAID_DOWNPAYMENT' ) {

                    $statuses = array( \Enums\Order_Payment_Status::DOWNPAYMENT_UNPAID->value, \Enums\Order_Payment_Status::DOWNPAYMENT_PARTIALLY_PAID->value );
                    if ( in_array( $row->HAS_UNPAID_DOWNPAYMENT, $statuses ) ) {
                        $value = 1;
                    } else {
                        $value = 0;
                    }
                } else if( $key == 'USER_CREATED' ) {
                    $date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT_FULL );
                    if( !is_null( $date ) ) {

                        // First scenario - format with date only (SHORT time)
                        $value = format_date($date, IntlDateFormatter::NONE);

                    }

                } else if( $key == 'NOW' ) {
                    $date = new DateTime();
                    if( !is_null( $date ) ) {

                        // Second scenario - format with both date and time
                        $value = format_date( $date );

                    }

                } else if( $key == 'CURDATE' ) {

                    $date = new DateTime();
                    if( !is_null( $date ) ) {

                        // First scenario - format with date only (SHORT time)
                        $value = format_date($date, IntlDateFormatter::NONE);


                    }

                } else if( $key == 'EF_DOB' ) {

                    $date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT );
                    if( !is_null( $date ) ) {
                        $value = format_date($date, IntlDateFormatter::NONE);;
                    }

                } else if( $key == 'DOWNPAYMENT_DUE_DATE' ) {

                    $date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT );
                    if( !is_null( $date ) ) {

                        $value = format_date($date, IntlDateFormatter::NONE);

                    }

                } else if( $key == 'EVENT_DATE_DAY' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'date' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->date ) )
                    ) ) {
                    $date = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'date' ] : $registration_data->events->date;
                    $date = DateTime::createFromFormat('Y-m-d H:i:s', $date );
                    $value = mysql_day_to_string( intval( $date->format( 'w' ) ) );
                } else if( $key == 'UPCOMING_EVENTS'  &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'upcoming_events' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->upcoming_events ) )
                    ) )   {
                    $value = is_array( $registration_data ) ? $registration_data[ 'upcoming_events' ] : $registration_data->upcoming_events;
                } else if( $key == 'EVENT_TIME' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'date' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->date ) )
                    ) )   {
                    $date = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'date' ] : $registration_data->events->date;
                    $date = DateTime::createFromFormat('Y-m-d H:i:s', $date );
                    $value = $date->format( 'H:i' );
                } else if( $key == 'COURSE_DATE' &&
                    (
                        ( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'date' ] ) )
                        || ( is_object( $registration_data ) && isset( $registration_data->events->date ) )
                    ) )   {
                    $date = is_array( $registration_data ) ? $registration_data[ 'events' ][ 'date' ] : $registration_data->events->date;
                    $date = DateTime::createFromFormat('Y-m-d H:i:s', $date );
                    $value = format_date( $date, IntlDateFormatter::NONE );
                        // ak nie je nastaveny najblizsi event, pouzije sa default (schedule.start)

                } else if( $key == 'COURSE_DATE' ) {
                    $date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT_FULL );
                    if( !is_null( $date ) ) {
                        $value = format_date( $date, IntlDateFormatter::NONE );
                    }
                } else if( $key == 'COURSE_TIME' ) {
                    $value = time_to_timestring( $value );
                    /*            } else if( $key == 'EVENT_TIME' ) {
                                    $value = time_to_timestring( $value );*/
                } else if( $key == 'COURSE_SUMMARY' )   {
                    $date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT_FULL );
                    if( !is_null( $date ) ) {
                        $value = format_date( $date, IntlDateFormatter::NONE ) . ' - ' . time_to_timestring( $row->__COURSE_SUMMARY_TIME ?? '' );
                    }
                } else if( $key == 'COURSE_DATE_START_END' )   {
                    $start_date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT_FULL )
                        ?? Utils::datetime_from_format( $value, Utils::DATE_FORMAT );
                    $end_date = Utils::datetime_from_format( $row->__COURSE_END_DATE ?? '', Utils::DATE_FORMAT_FULL )
                        ?? Utils::datetime_from_format( $row->__COURSE_END_DATE ?? '', Utils::DATE_FORMAT );
                    if( !is_null( $start_date ) && !is_null( $end_date ) ) {
                        $value = format_date( $start_date, IntlDateFormatter::NONE ) . ' - ' . format_date( $end_date, IntlDateFormatter::NONE );
                    }
                } else if( $key == 'DATE' )   {
                    $date = Utils::datetime_from_format( $value, Utils::DATE_FORMAT_FULL );
                    if( !is_null( $date ) ) {
                        $value = format_date( $date, IntlDateFormatter::NONE );
                    }
                } else if ( $key == 'WIDGET_VIDEO_URL' )    {

                    if( is_null ( $login_token ) )  {

                        $login_token = pull_login_code ( $email ) ;

                    }

                    if  ( $ret = parse_url( $row->WIDGET_VIDEO_URL ) ) {

                        if ( !isset( $ret[ "scheme" ] ) )   {

                            $row->WIDGET_VIDEO_URL = "//" . $row->WIDGET_VIDEO_URL;

                        }

                    }

                    $value = build_url( $row->WIDGET_VIDEO_URL, array(
                        'key' => $login_token,
                    ) );

                } else if ( $key == 'TURN_OFF_UPCOMING_EVENTS_NOTIFICATIONS_URL' )    {

                    $event_id = 0;

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'turn_off_upcoming_events_notifications', $row->REGISTRATION_ID, $event_id );
//var_dump($action_token);
                    $url = build_url( $row->TURN_OFF_UPCOMING_EVENTS_NOTIFICATIONS_URL, array(
                        'token' => $action_token,
                        'action' => 'turn_off_upcoming_events_notifications',
                    ) );
//var_dump($url);
                    $value = $url;

                } else if ( $key == 'BOOKING_TOKEN' )    {

                    $value = pull_action_code ( $email, $row->USER_ID, 'enroll', $row->REGISTRATION_ID, $row->__SCHEDULE_ID );

                } else if ( $key == 'BOOKING_URL' )    {

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'enroll', $row->REGISTRATION_ID, $row->__SCHEDULE_ID );
//                    var_dump($action_token);
                    $url = build_url( $row->BOOKING_URL, array(
                        'token'  => $action_token,
                        'action' => 'enroll',
                    ) );
//                    var_dump($url);
                    $value = $url;

                } else if ( $key == 'WIDGET_PROFILE_URL' )    {

                    if( is_null ( $login_token ) )  {

                        $login_token = pull_login_code ( $email, true ) ;

                    }


                    if  ( $ret = parse_url( $row->WIDGET_PROFILE_URL ) ) {

                        if ( !isset( $ret[ "scheme" ] ) )   {

                            $row->WIDGET_PROFILE_URL = "//" . $row->WIDGET_PROFILE_URL;

                        }

                    }

                    $value = build_url( $row->WIDGET_PROFILE_URL, array(
                        'token' => $login_token,
                    ), 'verify' );

                } else if( $key == 'PROFILE_TOKEN' )   {

                    if( is_null ( $login_token ) )  {

                        $login_token = pull_login_code ( $email, true ) ;

                    }

                    $value = $login_token;

                } else if( $key == 'GOING_CONFIRMATION_URL' )   {

                    $event_id = null;
                    if( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'id' ] ) )   {
                        $event_id = $registration_data[ 'events' ][ 'id' ];
                    } else if(  is_object( $registration_data ) && isset( $registration_data->events->id ) )  {
                        $event_id = $registration_data->events->id;
                    }

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'accept_waitlist', $row->REGISTRATION_ID, $event_id );

                    $url = build_url( $row->GOING_CONFIRMATION_URL, array(
                        'token' => $action_token,
                        'action' => 'accept_waitlist',
                    ) );

                    $value = $url;

                } else if( $key == 'CANCELED_CONFIRMATION_URL' )   {

                    $event_id = null;
                    if( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'id' ] ) )   {
                        $event_id = $registration_data[ 'events' ][ 'id' ];
                    } else if(  is_object( $registration_data ) && isset( $registration_data->events->id ) )  {
                        $event_id = $registration_data->events->id;
                    }

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'cancel_event', $row->REGISTRATION_ID, $event_id );
//todo toto by malo ist do profiloveho widgetu
                    $url = build_url( $row->CANCELED_CONFIRMATION_URL, array(
                        'token' => $action_token,
                        'action' => 'cancel_event',
                    ) );

                    $value = $url;

                } else if( $key == 'CANCEL_TOKEN' )   {

                    $event_id = null;
                    if( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'id' ] ) )   {
                        $event_id = $registration_data[ 'events' ][ 'id' ];
                    } else if(  is_object( $registration_data ) && isset( $registration_data->events->id ) )  {
                        $event_id = $registration_data->events->id;
                    }

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'cancel_event', $row->REGISTRATION_ID, $event_id );
                    $value = $action_token;

                } else if( $key == 'TURN_OFF_EVENT_NOTIFICATIONS_URL' )   {

                    $event_id = null;
                    if( is_array( $registration_data ) && isset( $registration_data[ 'events' ][ 'id' ] ) )   {
                        $event_id = $registration_data[ 'events' ][ 'id' ];
                    } else if(  is_object( $registration_data ) && isset( $registration_data->events->id ) )  {
                        $event_id = $registration_data->events->id;
                    }

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'turn_off_notifications', $row->REGISTRATION_ID, $event_id );

                    $url = build_url( $row->TURN_OFF_EVENT_NOTIFICATIONS_URL, array(
                        'token' => $action_token,
                        'action' => 'turn_off_notifications',
                    ) );

                    $value = $url;

                } else if( $key == 'VOTING' )   {

                    $action_token = pull_action_code ( $email, $row->USER_ID, 'feedback_vote', $registrations[ $row->REGISTRATION_ID ][ 'feedback_request_id' ] );

                    $vote_url = build_url( $row->VOTING, array(
                        'token' => $action_token,
                    ) );


                    $value = Feedback_Requests::get_voting_html( $vote_url );

                } else if( $key == 'FEEDBACK_REQUEST_ID' )  {

                    $value = $registrations[ $row->REGISTRATION_ID ][ 'feedback_request_id' ];

                } else if( $key == 'UNSUBSCRIBE' )  {

                    //aky typ unsubscribeu?
                    $unsubscribe_from = $registrations[ $row->REGISTRATION_ID ][ 'unsubscribe_from' ];
                    if( $unsubscribe_from == 'FEEDBACK' )   {

                        $action_token = pull_action_code ( $email, $row->USER_ID, 'unsubscribe_feedback', null );

                        $text = 'Ak si tieto emaily neželáte viac dostávať, <a href="%s" style="color: #fa6900;"><font color="#fa6900">odhláste sa z ich odberu</font></a>';
                        $vote_url = build_url( $row->UNSUBSCRIBE, array(
                            'token' => $action_token,
                        ) );

                        $value = sprintf( $text, $vote_url );

                    }
                }

                $vars[ $key ] = $value;
            }
//        var_dump('registration_id', $row->REGISTRATION_ID, 'registrations', $registrations);

            $registrations[ $row->REGISTRATION_ID ]['merge_vars'] = $this->get_merge_vars_array( $vars, $email );
        }

        #var_dump('merge_vars_end');
    }

    public function get_merge_vars_array( $merge_vars, $email ): array
    {

        $vars = array();

        if( $this->medium == 'whatsapp' )   {

            return $this->get_merge_vars_array__whatsapp( $merge_vars );

        }

        foreach ( $merge_vars as $name => $content )  {

            $vars[] = array(
                'name' => $name,
                'content' => $content,
            );
        }

        return array(
            'rcpt' => $email,
            'vars' => $vars,
        );
    }

    private function get_merge_vars_array__whatsapp( $merge_vars ): array   {

        $result = array();

        if( empty( $this->whatsapp_component_parameters ) ) {

            return $result;

        }

        $vars = $this->whatsapp_component_parameters; // this is the payload for the whatsapp components

        foreach( $merge_vars as $name => $content )  {

            foreach( $vars as $key => $component )  {

                foreach( $component[ 'parameters' ] as $idx => $var )    {

                    if( strtoupper( $var[ 'parameter_name' ] ) == strtoupper( $name ) ) {


                        $vars[ $key ][ 'parameters' ][ $idx ][ 'text' ] = $content;

//                        if( isset( $component[ 'sub_type' ] ) && $component[ 'sub_type' ] == 'url' ) {

//                            unset( $vars[ $key ][ 'parameters' ][ $idx ][ 'parameter_name' ] );

//                        }
                    }


                }

            }

        }

        return $vars;

    }

    public static function get_qr_code_html( mixed $row, bool $url_only = false ): string
    {

        $supported_regions = array( 'SK', 'CZ', 'RO', 'HU', 'GB', 'IE' );

        if( !in_array( strtoupper( $row->COMPANY_REGION ), $supported_regions ) )   {

            return '';

        }
        if( !isset( $row->QR_CODE ) || !isset( $row->IBAN_ONLY ) || !isset( $row->VARIABLE_SYMBOL ) || $row->IBAN_ONLY == '' ) {

            return '';

        }

        if( empty( $row->CURRENCY ) )   {

            $currency = Company::get_currency_by_region( $row->COMPANY_REGION );

        } else {

            $currency = $row->CURRENCY;

        }

        if( strtoupper( $row->COMPANY_REGION ) == 'SK' )    {


            $sk_query = array(
                'iban'      => $row->IBAN_ONLY,
                'amount'    => number_format( abs( floatval( $row->QR_CODE ) ), 2, '.', '' ),
                'currency'  => strtoupper( $currency ),
                'recipient' => $row->IBAN_ACCOUNT_HOLDER,
                'bic'       => $row->SWIFT,
                'vs'        => $row->VARIABLE_SYMBOL,
            );
            if( isset( $row->CONSTANT_SYMBOL ) && $row->CONSTANT_SYMBOL ) {
                $sk_query[ 'constantSymbol' ] = str_pad( $row->CONSTANT_SYMBOL, 4, '0', STR_PAD_LEFT );
            }
            if( isset( $row->SPECIFIC_SYMBOL ) && $row->SPECIFIC_SYMBOL ) {
                $sk_query[ 'specificSymbol' ] = $row->SPECIFIC_SYMBOL;
            }
            if( isset( $row->QR_DESCRIPTION ) && $row->QR_DESCRIPTION !== '' ) {
                $sk_query[ 'description' ] = $row->QR_DESCRIPTION;
            }
            $qr_url = QR_CODE_URL . 'payment/sk?' . http_build_query( $sk_query );

            if( $url_only ) {
                return $qr_url;
            }

            $html = '<div style="border: 5px solid #6FA4D7;padding: 20px;margin: 20px auto;max-width: 300px;border-radius: 5px;">
                    <img src="' . $qr_url . '" style="margin-bottom: 10px; display: block;max-width: 300px;width: 100%;height: auto;image-rendering: pixelated;image-rendering: -moz-crisp-edges;image-rendering: crisp-edges;"><img src="https://qr.zooza.sk/assets/paybysquare.png" style="max-width: 300px;width: 100%;display: block;">
                 </div>';

            return $html;

        }


        $query_vars = array(
            'iban'      => $row->IBAN_ONLY,
            'amount'    => number_format( abs( floatval( $row->QR_CODE ) ), 2, '.', '' ),
            'currency'  => strtoupper( $currency ),
            'vs'        => $row->VARIABLE_SYMBOL,
            'recipient' => $row->COMPANY_NAME,
            'beneficiaryName' => $row->IBAN_ACCOUNT_HOLDER,
        );

        if( isset( $row->QR_DESCRIPTION ) && $row->QR_DESCRIPTION !== '' ) {
            $query_vars[ 'description' ] = $row->QR_DESCRIPTION;
        }

        if( in_array( strtoupper( $row->COMPANY_REGION ), array( 'RO', 'HU' ) ) && isset( $row->SWIFT ) && $row->SWIFT !== '' ) {
            $query_vars[ 'bic' ] = $row->SWIFT;
        }

        if( isset( $row->CONSTANT_SYMBOL ) && $row->CONSTANT_SYMBOL )    {

            $query_vars[ 'constantSymbol' ] = str_pad($row->CONSTANT_SYMBOL, 4, '0', STR_PAD_LEFT);

        }

        if( isset( $row->SPECIFIC_SYMBOL ) && $row->SPECIFIC_SYMBOL )    {

            $query_vars[ 'specificSymbol' ] = $row->SPECIFIC_SYMBOL;

        }

        $qr_url = QR_CODE_URL . 'payment/' . $row->COMPANY_REGION . '?' . http_build_query( $query_vars );

        if( $url_only ) {
            return $qr_url;
        }

        $html = '<div style="border: 5px solid #6FA4D7;padding: 20px;margin: 20px auto;max-width: 300px;border-radius: 5px;">
                <img src="' . $qr_url . '" style="margin-bottom: 10px; display: block;max-width: 300px;width: 100%;height: auto;image-rendering: pixelated;image-rendering: -moz-crisp-edges;image-rendering: crisp-edges;"><img src="https://qr.zooza.sk/assets/paybysquare.png" style="max-width: 300px;width: 100%;display: block;">
             </div>';
        return $html;

    }

}
