<?php
/**
 * The main template file (blog index fallback).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
?>

<div class="page-hero">
	<div class="container">
		<h1><?php esc_html_e( 'News & Reflections', 'glasgow-bahai' ); ?></h1>
	</div>
</div>

<main id="primary" class="site-main">
	<div class="container">
		<?php
		if ( have_posts() ) :
			while ( have_posts() ) :
				the_post();
				get_template_part( 'template-parts/content', get_post_type() );
			endwhile;
			the_posts_navigation();
		else :
			get_template_part( 'template-parts/content', 'none' );
		endif;
		?>
	</div>
</main>

<?php get_footer(); ?>
